package app.orbit.data

import android.util.Log
import app.orbit.service.Live
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Sunucuyla sürekli açık canlı bağlantı (Supabase Realtime).
 * Panelde bir değişiklik olunca (kural, komut, süre, görev, yeni ebeveyn cihazı…) sunucu hemen haber verir;
 * telefon 1–2 sn içinde kuralları yeniden alır. Bağlantı koparsa kendiliğinden yeniden bağlanır.
 * 30 sn'lik düzenli kontrol yedek olarak devam eder.
 */
object Realtime {
    private const val TAG = "OrbitRealtime"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    private val ref = AtomicInteger(1)
    @Volatile private var ws: WebSocket? = null
    @Volatile private var connected = false
    private var loop: Job? = null

    /** Telefonun kendi yazdıkları (durum, kullanım, olaylar) burada yok — kendi kendini tetiklemesin. */
    private val childTables = listOf("commands", "child_apps", "time_grants", "profile_assignments", "day_overrides", "task_runs", "messages", "timer_sessions", "alarms", "agenda_items", "task_group_runs")
    private val familyTables = listOf(
        "rule_profiles", "modes", "mode_slots", "profile_sections", "section_rules",
        "app_groups", "app_group_members", "profile_group_limits", "tasks", "vault_holders", "focus_profiles", "activities",
        "time_rules", "children",
    )

    val isConnected get() = connected

    fun start() {
        if (loop?.isActive == true) return
        loop = scope.launch {
            var backoff = 2_000L
            while (isActive) {
                val c = Store.creds
                if (c == null) { delay(10_000); continue }
                val opened = runCatching { connect(c.childId) }.getOrElse { Log.w(TAG, "bağlanamadı", it); false }
                if (opened) {
                    backoff = 2_000L
                    // Bağlıyken: kalp atışı ve oturum anahtarını tazele; kopunca döngü yeniden bağlar
                    var beats = 0
                    while (isActive && connected) {
                        delay(25_000)
                        send("phoenix", "heartbeat", JSONObject())
                        if (++beats % 80 == 0) runCatching { send(topic(c.childId), "access_token", JSONObject().put("access_token", Api.accessToken())) }
                    }
                }
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(60_000)
            }
        }
    }

    fun stop() {
        loop?.cancel(); loop = null
        ws?.close(1000, "stop"); ws = null
        connected = false
    }

    private fun topic(child: String) = "realtime:orbit-$child"

    private fun connect(child: String): Boolean {
        val token = Api.accessToken()
        val url = Api.baseUrl.replaceFirst("https://", "wss://") + "/realtime/v1/websocket?apikey=${Api.apiKey}&vsn=1.0.0"
        val changes = JSONArray()
        for (t in childTables) changes.put(JSONObject().put("event", "*").put("schema", "orbit").put("table", t).put("filter", "child_id=eq.$child"))
        for (t in familyTables) changes.put(JSONObject().put("event", "*").put("schema", "orbit").put("table", t))
        val join = JSONObject()
            .put("config", JSONObject()
                .put("broadcast", JSONObject().put("self", false))
                .put("presence", JSONObject().put("key", ""))
                .put("postgres_changes", changes))
            .put("access_token", token)

        val done = java.util.concurrent.CountDownLatch(1)
        var ok = false
        ws = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(msg(topic(child), "phx_join", join))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val m = runCatching { JSONObject(text) }.getOrNull() ?: return
                when (m.optString("event")) {
                    "phx_reply" -> if (m.optString("topic") == topic(child) && !ok) {
                        ok = m.optJSONObject("payload")?.optString("status") == "ok"
                        connected = ok
                        if (ok) Live.syncRequested = true
                        done.countDown()
                    }
                    "postgres_changes" -> onChange(m.optJSONObject("payload")?.optJSONObject("data"))
                    "phx_error", "phx_close" -> { connected = false; done.countDown() }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { connected = false; done.countDown() }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "bağlantı koptu: ${t.message}")
                connected = false; done.countDown()
            }
        })
        done.await(20, TimeUnit.SECONDS)
        if (!ok) { ws?.cancel(); ws = null }
        return ok
    }

    private fun onChange(d: JSONObject?) {
        val table = d?.optString("table") ?: return
        Live.syncRequested = true
        // Telefonu bul: beklemeden çal (tam eşitlemeyi beklemeden)
        val rec = d.optJSONObject("record")
        if (table == "commands" && rec?.optJSONObject("payload")?.has("find") == true) {
            runCatching { app.orbit.ui.FindPhone.handle(Store.appCtx, rec.getString("id"), rec.getJSONObject("payload"), rec.optString("created_at")) }
        }
        if (table == "vault_holders" || table == "commands" && d.optJSONObject("record")?.optJSONObject("payload")?.optBoolean("vault") == true) {
            Vault.shareSoon()
        }
    }

    private fun msg(topic: String, event: String, payload: JSONObject) =
        JSONObject().put("topic", topic).put("event", event).put("payload", payload).put("ref", ref.getAndIncrement().toString()).toString()

    private fun send(topic: String, event: String, payload: JSONObject) {
        ws?.send(msg(topic, event, payload))
    }
}
