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
 * 30 sn'lik düzenli kontrol yedek olarak devam eder. Tek yayın kanalı kullanılır (sunucu disk yükü az).
 */
object Realtime {
    private const val TAG = "OrbitRealtime"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    private val ref = AtomicInteger(1)
    @Volatile private var ws: WebSocket? = null
    @Volatile private var connected = false
    @Volatile private var lastMsgAt = 0L
    @Volatile private var kicked = false
    private var loop: Job? = null

    val isConnected get() = connected

    /** Ekran açıldı / internet geldi: bağlı değilse beklemeden yeniden bağlan */
    fun kick() {
        if (!connected) kicked = true
        if (loop?.isActive != true) start()
    }

    fun start() {
        if (loop?.isActive == true) return
        loop = scope.launch {
            var backoff = 2_000L
            while (isActive) {
                val c = Store.creds
                if (c == null) { delay(10_000); continue }
                kicked = false
                val opened = runCatching { connect(c.childId) }.getOrElse { Log.w(TAG, "bağlanamadı", it); false }
                if (opened) {
                    backoff = 2_000L
                    // Bağlıyken: kalp atışı; 70 sn hiç cevap gelmezse bağlantı ölü sayılır ve yenilenir
                    var beats = 0
                    while (isActive && connected) {
                        delay(25_000)
                        if (!connected) break
                        if (System.currentTimeMillis() - lastMsgAt > 70_000) {
                            Log.w(TAG, "cevap yok, yeniden bağlanılıyor")
                            connected = false
                            ws?.cancel(); ws = null
                            break
                        }
                        send("phoenix", "heartbeat", JSONObject())
                        if (++beats % 80 == 0) runCatching { send(topic(c.childId), "access_token", JSONObject().put("access_token", Api.accessToken())) }
                    }
                }
                // Bekleme sırasında ekran açılırsa (kick) hemen dene
                var waited = 0L
                while (isActive && waited < backoff && !kicked) { delay(1_000); waited += 1_000 }
                backoff = if (kicked) 2_000L else (backoff * 2).coerceAtMost(60_000)
            }
        }
    }

    fun stop() {
        loop?.cancel(); loop = null
        ws?.close(1000, "stop"); ws = null
        connected = false
    }

    private fun topic(child: String) = "realtime:orbit-$child"

    /** Tek yayın kanalı: sunucu ilgili tablolar değişince "changed" gönderir (orbit.rt_notify) */
    private fun connect(child: String): Boolean {
        val token = Api.accessToken()
        val url = Api.baseUrl.replaceFirst("https://", "wss://") + "/realtime/v1/websocket?apikey=${Api.apiKey}&vsn=1.0.0"
        val join = JSONObject()
            .put("config", JSONObject()
                .put("broadcast", JSONObject().put("self", false).put("ack", false))
                .put("presence", JSONObject().put("key", ""))
                .put("postgres_changes", JSONArray())
                .put("private", false))
            .put("access_token", token)

        val done = java.util.concurrent.CountDownLatch(1)
        var ok = false
        ws?.cancel()
        ws = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                lastMsgAt = System.currentTimeMillis()
                webSocket.send(msg(topic(child), "phx_join", join))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                lastMsgAt = System.currentTimeMillis()
                val m = runCatching { JSONObject(text) }.getOrNull() ?: return
                when (m.optString("event")) {
                    "phx_reply" -> if (m.optString("topic") == topic(child) && !ok) {
                        ok = m.optJSONObject("payload")?.optString("status") == "ok"
                        connected = ok
                        if (ok) Live.syncRequested = true
                        done.countDown()
                    }
                    "broadcast" -> onChange(m.optJSONObject("payload")?.optJSONObject("payload"))
                    "phx_error", "phx_close" -> if (m.optString("topic") == topic(child)) { connected = false; done.countDown() }
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
        if (table == "vault_holders" || table == "commands" && rec?.optJSONObject("payload")?.optBoolean("vault") == true) {
            Vault.shareSoon()
        }
    }

    private fun msg(topic: String, event: String, payload: JSONObject) =
        JSONObject().put("topic", topic).put("event", event).put("payload", payload).put("ref", ref.getAndIncrement().toString()).toString()

    private fun send(topic: String, event: String, payload: JSONObject) {
        ws?.send(msg(topic, event, payload))
    }
}
