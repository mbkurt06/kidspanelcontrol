package app.orbit.data

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

/**
 * Kelime kartları (Fransızca – Almanca).
 * Desteler ailede ortak; her çocuk istediği desteyi çalışma alanına alır. İlerleme çocuğa özel (aralıklı tekrar kutuları).
 * Çevrimdışı da çalışır: son liste saklanır, bitmiş çalışmalar internet gelince gönderilir.
 */
data class VCard(
    val id: String, val fr: String, val de: String, val ex: String?, val mine: Boolean,
    val box: Int, val due: LocalDate?, val right: Int, val wrong: Int,
) {
    val isNew get() = box == 0
    val learned get() = box >= 4
    fun dueOn(day: LocalDate) = !isNew && (due == null || !due.isAfter(day))
}

data class VDeck(val id: String, val name: String, val mine: Boolean, val by: String, val study: Boolean, val cards: List<VCard>)

data class VSettings(val direction: String = "fr_de", val dailyGoal: Int = 20, val allowClosed: Boolean = true)

data class VState(val settings: VSettings, val today: LocalDate, val doneToday: Int, val decks: List<VDeck>)

/** Çalışmada bir kartın sonucu: ilk cevabı biliyor muydu, kaç kez soruldu */
data class VResult(val cardId: String, val known: Boolean, val asked: Int)

object Vocab {
    private const val TAG = "OrbitVocab"
    private val _state = MutableStateFlow<VState?>(null)
    val state: StateFlow<VState?> = _state

    fun cached(): VState? {
        _state.value?.let { return it }
        val s = Store.prefs().getString("vocab", null)?.let { runCatching { parse(JSONObject(it)) }.getOrNull() }
        _state.value = s
        return s
    }

    /** Sunucudan yükle (önce bekleyen çalışmaları gönder) */
    fun load(): String? = runCatching {
        flushPending()
        val raw = Api.rpc("device_vocab", JSONObject())
        val s = parse(JSONObject(raw))
        Store.prefs().edit().putString("vocab", raw).apply()
        _state.value = s
        null
    }.getOrElse { Log.w(TAG, "yüklenemedi", it); cached(); "İnternet yok, son kaydedilen liste gösteriliyor" }

    private fun parse(o: JSONObject): VState {
        val st = o.optJSONObject("settings") ?: JSONObject()
        val decks = o.optJSONArray("decks") ?: JSONArray()
        return VState(
            settings = VSettings(st.optString("direction", "fr_de"), st.optInt("daily_goal", 20), st.optBoolean("allow_closed", true)),
            today = runCatching { LocalDate.parse(o.optString("today")) }.getOrDefault(LocalDate.now()),
            doneToday = o.optInt("done_today"),
            decks = (0 until decks.length()).map { i ->
                val d = decks.getJSONObject(i)
                val cs = d.optJSONArray("cards") ?: JSONArray()
                VDeck(
                    d.getString("id"), d.optString("name"), d.optBoolean("mine"), d.optString("by"), d.optBoolean("study"),
                    (0 until cs.length()).map { j ->
                        val c = cs.getJSONObject(j)
                        VCard(
                            c.getString("id"), c.optString("fr"), c.optString("de"), c.optString("ex").takeIf { !c.isNull("ex") && it.isNotBlank() },
                            c.optBoolean("mine"), c.optInt("box"), if (c.isNull("due")) null else runCatching { LocalDate.parse(c.optString("due")) }.getOrNull(),
                            c.optInt("right"), c.optInt("wrong"),
                        )
                    },
                )
            },
        )
    }

    fun addDeck(name: String): String? = runCatching {
        Api.rpc("device_vocab_deck", JSONObject().put("p_name", name.trim())).trim('"')
    }.getOrNull()?.also { load() }

    /** "le chat - die Katze" satırları; ayraç: " - ", " = ", tab ya da ";" */
    fun parseLines(text: String): List<Pair<String, String>> = text.lines().mapNotNull { line ->
        val l = line.trim()
        if (l.isEmpty()) return@mapNotNull null
        val sep = listOf("\t", " = ", " - ", " – ", ";", "=").firstOrNull { l.contains(it) } ?: return@mapNotNull null
        val i = l.indexOf(sep)
        val a = l.substring(0, i).trim()
        val b = l.substring(i + sep.length).trim()
        if (a.isEmpty() || b.isEmpty()) null else a to b
    }

    fun addCards(deckId: String, cards: List<Triple<String, String, String?>>): Int? = runCatching {
        val arr = JSONArray()
        for ((fr, de, ex) in cards) arr.put(JSONObject().put("fr", fr).put("de", de).put("ex", ex ?: JSONObject.NULL))
        Api.rpc("device_vocab_add", JSONObject().put("p_deck", deckId).put("p_cards", arr)).trim().toIntOrNull()
    }.getOrNull()?.also { load() }

    fun editCard(id: String, fr: String, de: String, ex: String?, delete: Boolean): Boolean = runCatching {
        Api.rpc("device_vocab_card", JSONObject().put("p_card", id).put("p_fr", fr).put("p_de", de).put("p_ex", ex ?: JSONObject.NULL).put("p_delete", delete))
    }.isSuccess.also { if (it) load() }

    fun setStudy(deckId: String, on: Boolean): Boolean = runCatching {
        Api.rpc("device_vocab_study", JSONObject().put("p_deck", deckId).put("p_on", on))
    }.isSuccess.also { if (it) load() }

    fun setSettings(direction: String, goal: Int): Boolean = runCatching {
        Api.rpc("device_vocab_settings", JSONObject().put("p_direction", direction).put("p_goal", goal))
    }.isSuccess.also { if (it) load() }

    /** Çalışma bitti: sunucuya gönder; internet yoksa sakla, sonra gönderilir */
    fun finishSession(startedAt: Long, seconds: Int, results: List<VResult>): JSONObject? {
        if (results.isEmpty()) return null
        val body = JSONObject()
            .put("p_started", java.time.Instant.ofEpochMilli(startedAt).toString())
            .put("p_seconds", seconds)
            .put("p_results", JSONArray().apply { results.forEach { put(JSONObject().put("card", it.cardId).put("known", it.known).put("n", it.asked)) } })
        val r = runCatching { JSONObject(Api.rpc("device_vocab_session", body)) }.getOrNull()
        if (r == null) {
            val arr = JSONArray(Store.prefs().getString("vocabPending", "[]"))
            arr.put(body)
            Store.prefs().edit().putString("vocabPending", arr.toString()).apply()
        } else {
            app.orbit.service.Live.syncRequested = true
            load()
        }
        return r
    }

    private fun flushPending() {
        val arr = JSONArray(Store.prefs().getString("vocabPending", "[]"))
        if (arr.length() == 0) return
        val left = JSONArray()
        for (i in 0 until arr.length()) {
            val ok = runCatching { Api.rpc("device_vocab_session", arr.getJSONObject(i)) }.isSuccess
            if (!ok) left.put(arr.getJSONObject(i))
        }
        Store.prefs().edit().putString("vocabPending", left.toString()).apply()
        if (left.length() < arr.length()) app.orbit.service.Live.syncRequested = true
    }

    /**
     * Bugünkü çalışma: çalışma alanındaki destelerden zamanı gelen tekrarlar önce, sonra yeni kartlar; toplam günlük hedef kadar.
     * deckId verilirse sadece o deste (hepsi, sırası karışık).
     */
    fun buildSession(s: VState, deckId: String? = null): List<VCard> {
        if (deckId != null) return s.decks.firstOrNull { it.id == deckId }?.cards.orEmpty().shuffled()
        val cards = s.decks.filter { it.study }.flatMap { it.cards }.distinctBy { it.id }
        val due = cards.filter { it.dueOn(s.today) }.sortedBy { it.due }
        val goal = (s.settings.dailyGoal - s.doneToday).coerceAtLeast(10)
        val fresh = cards.filter { it.isNew }
        return (due + fresh).take(maxOf(goal, due.size.coerceAtMost(100))).shuffled()
    }
}
