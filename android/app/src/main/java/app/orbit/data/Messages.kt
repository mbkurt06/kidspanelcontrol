package app.orbit.data

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Sohbetler (sadece yazı): anneyle / babayla birebir, ebeveynin kurduğu gruplar.
 * Ebeveyn sohbeti durdurabilir (çocuk okur ama yazamaz). Alıntılı yanıt; çocuk kendi mesajını 10 dk içinde silebilir.
 */
object Messages {
    private const val TAG = "OrbitMessages"
    private const val NOTE_ID = 7001

    data class Chat(
        val id: String, val kind: String, val title: String, val canWrite: Boolean,
        /** frozen = ebeveyn durdurdu · parents_only = grupta sadece ebeveynler yazar */
        val readonly: String?, val frozenUntil: Long?, val readAt: Long,
    ) {
        val group get() = kind == "group"
    }

    data class Msg(
        val id: String, val chatId: String, val fromParent: Boolean, val childId: String?, val sender: String?,
        val body: String, val at: Long, val read: Boolean, val replyTo: String?, val deleted: Boolean,
    )

    private val _chats = MutableStateFlow<List<Chat>>(emptyList())
    val chats: StateFlow<List<Chat>> = _chats.asStateFlow()
    private val _list = MutableStateFlow<List<Msg>>(emptyList())
    /** Bütün sohbetlerin mesajları (eskiden yeniye) */
    val list: StateFlow<List<Msg>> = _list.asStateFlow()
    /** Çocuk bir sohbet ekranındayken o sohbetin bildirimini gösterme, okundu say */
    @Volatile var openChat: String? = null
    @Volatile var screenOpen = false
    private val busy = AtomicBoolean(false)

    fun mine(m: Msg) = !m.fromParent && m.childId == Store.creds?.childId

    /** Sohbetteki okunmamışlar (başkalarının, son okumadan sonraki) */
    fun unread(chat: Chat, all: List<Msg> = _list.value) = all.count { it.chatId == chat.id && !mine(it) && !it.deleted && it.at > chat.readAt }
    val unread get() = _chats.value.sumOf { unread(it) }

    fun refresh() {
        Store.creds ?: return
        if (!busy.compareAndSet(false, true)) return
        try {
            val cs = runCatching { JSONArray(Api.rpc("device_chats", JSONObject())) }.getOrElse { JSONArray() }
            val chats = (0 until cs.length()).map { cs.getJSONObject(it) }.map {
                Chat(
                    it.getString("id"), it.optString("kind"), it.optString("title", "Sohbet"), it.optBoolean("can_write", true),
                    if (it.isNull("readonly")) null else it.optString("readonly"),
                    if (it.isNull("frozen_until")) null else Parse.ts(it.optString("frozen_until")),
                    if (it.isNull("read_at")) 0L else Parse.ts(it.optString("read_at")) ?: 0L,
                )
            }
            val a = Api.get("messages?select=id,chat_id,from_parent,child_id,sender_name,body,created_at,read_at,reply_to,deleted_at&order=created_at.desc&limit=400")
            val items = (0 until a.length()).map { a.getJSONObject(it) }.map {
                Msg(
                    it.getString("id"), it.optString("chat_id"), it.optBoolean("from_parent"),
                    if (it.isNull("child_id")) null else it.optString("child_id"),
                    if (it.isNull("sender_name")) null else it.optString("sender_name"),
                    it.optString("body"), Parse.ts(it.optString("created_at")) ?: 0L, !it.isNull("read_at"),
                    if (it.isNull("reply_to")) null else it.optString("reply_to"), !it.isNull("deleted_at"),
                )
            }.reversed()
            _chats.value = chats
            _list.value = items
            val lastSeen = Store.prefs().getLong("msgNotified", 0)
            val fresh = items.filter { !mine(it) && !it.deleted && it.at > lastSeen && chats.firstOrNull { ch -> ch.id == it.chatId }?.let { ch -> it.at > ch.readAt } == true }
            if (fresh.isNotEmpty()) {
                Store.prefs().edit().putLong("msgNotified", fresh.maxOf { it.at }).apply()
                val open = openChat
                val notify = fresh.filter { it.chatId != open }
                if (open != null && fresh.any { it.chatId == open }) markRead(open)
                if (notify.isNotEmpty()) {
                    val last = notify.last()
                    val chat = chats.firstOrNull { it.id == last.chatId }
                    val who = if (chat?.group == true) "${chat.title} · ${last.sender ?: ""}" else last.sender ?: chat?.title ?: "Mesaj"
                    Notifier.show(Notifier.CH_MSG, NOTE_ID, who, if (notify.size > 1) "${notify.size} yeni mesaj · ${last.body}" else last.body, "MESSAGES")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "mesajlar alınamadı", e)
        } finally {
            busy.set(false)
        }
    }

    /** Gönder; hata olursa sebebi (durduruldu / sadece ebeveyn / internet) */
    fun send(chatId: String, body: String, replyTo: String?): String? {
        val c = Store.creds ?: return "Kayıt yok"
        val text = body.trim().take(1000)
        if (text.isEmpty()) return "Boş mesaj"
        return runCatching {
            Api.post(
                "messages",
                JSONObject().put("family_id", c.familyId).put("child_id", c.childId).put("chat_id", chatId)
                    .put("from_parent", false).put("body", text).put("reply_to", replyTo ?: JSONObject.NULL),
            )
            refresh()
            null
        }.getOrElse {
            Log.w(TAG, "gönderilemedi", it)
            val m = it.message ?: ""
            refresh()
            when {
                "chat_frozen" in m -> "Bu sohbet durduruldu, mesaj yazamazsın"
                "chat_readonly" in m -> "Bu grupta sadece ebeveynler yazabiliyor"
                else -> "Gönderilemedi, internet bağlantısını kontrol et"
            }
        }
    }

    /** Kendi mesajını sil (gönderdikten sonra 10 dk içinde) */
    fun delete(id: String): Boolean = runCatching {
        Api.rpc("message_delete", JSONObject().put("p_id", id))
        refresh()
        true
    }.getOrElse { Log.w(TAG, "silinemedi", it); false }

    fun canDelete(m: Msg) = mine(m) && !m.deleted && System.currentTimeMillis() - m.at < 10 * 60_000L

    fun markRead(chatId: String) {
        val chat = _chats.value.firstOrNull { it.id == chatId } ?: return
        if (unread(chat) == 0) return
        runCatching {
            Api.rpc("chat_mark_read", JSONObject().put("p_chat", chatId))
            val now = System.currentTimeMillis()
            _chats.value = _chats.value.map { if (it.id == chatId) it.copy(readAt = now) else it }
            if (unread == 0) Notifier.cancel(NOTE_ID)
        }
    }
}
