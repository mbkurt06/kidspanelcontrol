package app.orbit.data

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean

/** Çocuk ↔ ebeveyn mesajları (sadece yazı). */
object Messages {
    private const val TAG = "OrbitMessages"
    private const val NOTE_ID = 7001

    data class Msg(val id: String, val fromParent: Boolean, val sender: String?, val body: String, val at: Long, val read: Boolean)

    private val _list = MutableStateFlow<List<Msg>>(emptyList())
    val list: StateFlow<List<Msg>> = _list.asStateFlow()
    /** Çocuk Mesajlar ekranındayken yeni mesaj bildirimi gösterme, okundu say */
    @Volatile var screenOpen = false
    private val busy = AtomicBoolean(false)

    val unread get() = _list.value.count { it.fromParent && !it.read }

    fun refresh() {
        val c = Store.creds ?: return
        if (!busy.compareAndSet(false, true)) return
        try {
            val a = Api.get("messages?child_id=eq.${c.childId}&select=id,from_parent,sender_name,body,created_at,read_at&order=created_at.desc&limit=100")
            val items = (0 until a.length()).map { a.getJSONObject(it) }.map {
                Msg(
                    it.getString("id"), it.optBoolean("from_parent"),
                    if (it.isNull("sender_name")) null else it.optString("sender_name"),
                    it.optString("body"), Parse.ts(it.optString("created_at")) ?: 0L, !it.isNull("read_at"),
                )
            }.reversed()
            _list.value = items
            val lastSeen = Store.prefs().getLong("msgNotified", 0)
            val fresh = items.filter { it.fromParent && !it.read && it.at > lastSeen }
            if (fresh.isNotEmpty()) {
                Store.prefs().edit().putLong("msgNotified", fresh.maxOf { it.at }).apply()
                if (screenOpen) markRead()
                else {
                    val last = fresh.last()
                    Notifier.show(Notifier.CH_MSG, NOTE_ID, last.sender ?: "Ebeveynin", if (fresh.size > 1) "${fresh.size} yeni mesaj · ${last.body}" else last.body, "MESSAGES")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "mesajlar alınamadı", e)
        } finally {
            busy.set(false)
        }
    }

    fun send(body: String): Boolean {
        val c = Store.creds ?: return false
        val text = body.trim().take(1000)
        if (text.isEmpty()) return false
        return runCatching {
            Api.post("messages", JSONObject().put("family_id", c.familyId).put("child_id", c.childId).put("from_parent", false).put("body", text))
            refresh()
            true
        }.getOrElse { Log.w(TAG, "gönderilemedi", it); false }
    }

    fun markRead() {
        val c = Store.creds ?: return
        if (_list.value.none { it.fromParent && !it.read }) return
        runCatching {
            Api.patch("messages?child_id=eq.${c.childId}&from_parent=eq.true&read_at=is.null", JSONObject().put("read_at", Instant.now().toString()))
            _list.value = _list.value.map { if (it.fromParent) it.copy(read = true) else it }
            Notifier.cancel(NOTE_ID)
        }
    }
}
