package app.orbit.data

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import app.orbit.service.PlanReceiver
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.UUID

/**
 * Planım: çocuğun kendi yapılacakları ve hatırlatmaları. Kurallarla / süreyle bağlantısı yoktur; ebeveyn panelde sadece görür.
 * Önce telefonda saklanır (internet yokken de çalışır), sunucuya yazılamayan işlemler sırada bekler.
 */
object Plan {
    private const val TAG = "OrbitPlan"

    data class Category(val id: String?, val name: String, val emoji: String)

    val DEFAULTS = listOf(
        Category(null, "Ders", "📚"), Category(null, "Ödev", "✏️"), Category(null, "Dinlenme", "🛋️"),
        Category(null, "Okuma", "📖"), Category(null, "Spor", "⚽"), Category(null, "Diğer", "📌"),
    )
    val REPEATS = listOf("none" to "Yok", "daily" to "Her gün", "weekdays" to "Hafta içi", "days" to "Seçili günler")
    val BEFORE = listOf(0, 5, 10, 15, 30)

    data class Item(
        val id: String,
        val day: LocalDate,
        val title: String,
        val category: String? = null,
        val emoji: String? = null,
        val at: LocalTime? = null,
        val remind: Boolean = false,
        val remindBefore: Int = 0,
        val repeat: String = "none",
        val repeatDays: Set<Int> = emptySet(),
        val endsOn: LocalDate? = null,
        val createdAt: String = "",
    ) {
        fun occursOn(d: LocalDate): Boolean {
            if (repeat == "none") return d == day
            if (d.isBefore(day) || (endsOn != null && d.isAfter(endsOn))) return false
            return when (repeat) {
                "daily" -> true
                "weekdays" -> d.dayOfWeek.value <= 5
                "days" -> d.dayOfWeek.value in repeatDays
                else -> false
            }
        }
    }

    data class Check(val itemId: String, val day: LocalDate, val done: Boolean, val skipped: Boolean)
    data class State(
        val loaded: Boolean = false,
        val items: List<Item> = emptyList(),
        val checks: Map<String, Check> = emptyMap(),
        val categories: List<Category> = emptyList(),
        val error: String? = null,
    ) {
        val allCategories get() = DEFAULTS + categories
        fun isDone(i: Item, d: LocalDate) = checks[key(i.id, d)]?.done == true
        fun forDay(d: LocalDate): List<Item> = items
            .filter { it.occursOn(d) && checks[key(it.id, d)]?.skipped != true }
            .sortedWith(compareBy<Item>({ it.at == null }, { it.at }, { it.createdAt }))
    }

    private fun key(id: String, d: LocalDate) = "$id@$d"

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()
    @Volatile private var app: Context? = null

    fun zone(): ZoneId = runCatching { ZoneId.of(Store.rules().timezone) }.getOrDefault(ZoneId.systemDefault())
    fun today(): LocalDate = LocalDate.now(zone())

    fun init(ctx: Context) {
        app = ctx.applicationContext
        if (!_state.value.loaded) runCatching { Store.prefs().getString("plan.cache", null)?.let { _state.value = decode(JSONObject(it)); reschedule() } }
    }

    // --- Sunucu (IO iş parçacığında) ---

    fun refresh() {
        val c = Store.creds ?: return
        flush()
        runCatching {
            val since = today().minusDays(40)
            val items = Api.get("plan_items?child_id=eq.${c.childId}&or=(repeat.neq.none,day.gte.$since)&select=*&order=created_at.asc")
            val checks = Api.get("plan_checks?child_id=eq.${c.childId}&day=gte.$since&select=item_id,day,done,skipped")
            val cats = Api.get("plan_categories?child_id=eq.${c.childId}&select=*&order=created_at.asc")
            if (pending().length() > 0) return // bu arada yeni değişiklik oldu: yereli koru
            val s = decode(JSONObject().put("items", items).put("checks", checks).put("categories", cats))
            set(s)
        }.onFailure {
            Log.w(TAG, "plan alınamadı", it)
            _state.value = _state.value.copy(loaded = true, error = it.message)
        }
    }

    fun save(item: Item) {
        val c = Store.creds ?: return
        update { s -> s.copy(items = s.items.filter { it.id != item.id } + item) }
        enqueue("upsert", "plan_items", encodeItem(item).put("family_id", c.familyId).put("child_id", c.childId).put("updated_at", java.time.Instant.now().toString()))
    }

    fun newItem(day: LocalDate, title: String) = Item(UUID.randomUUID().toString(), day, title, createdAt = java.time.Instant.now().toString())

    fun setDone(item: Item, day: LocalDate, done: Boolean) {
        val c = Store.creds ?: return
        update { s -> s.copy(checks = s.checks + (key(item.id, day) to Check(item.id, day, done, false))) }
        enqueue("upsert", "plan_checks", JSONObject().put("item_id", item.id).put("day", day.toString()).put("family_id", c.familyId)
            .put("child_id", c.childId).put("done", done).put("skipped", false).put("at", java.time.Instant.now().toString()))
    }

    /** Tekrarlayan maddede [onlyDay] verilirse sadece o gün listeden kalkar; yoksa madde tamamen silinir */
    fun delete(item: Item, onlyDay: LocalDate?) {
        val c = Store.creds ?: return
        if (onlyDay != null && item.repeat != "none") {
            update { s -> s.copy(checks = s.checks + (key(item.id, onlyDay) to Check(item.id, onlyDay, false, true))) }
            enqueue("upsert", "plan_checks", JSONObject().put("item_id", item.id).put("day", onlyDay.toString()).put("family_id", c.familyId)
                .put("child_id", c.childId).put("done", false).put("skipped", true))
        } else {
            update { s -> s.copy(items = s.items.filter { it.id != item.id }, checks = s.checks.filterValues { it.itemId != item.id }) }
            enqueue("delete", "plan_items?id=eq.${item.id}", null)
        }
    }

    /** Dünkü (tekrarsız) maddeleri bugüne kopyala; aynı başlık varsa atla */
    fun copyDay(from: LocalDate, to: LocalDate): Int {
        val s = _state.value
        val have = s.forDay(to).map { it.title.lowercase() }.toSet()
        val src = s.forDay(from).filter { it.repeat == "none" && it.title.lowercase() !in have }
        src.forEach { save(it.copy(id = UUID.randomUUID().toString(), day = to, createdAt = java.time.Instant.now().toString())) }
        return src.size
    }

    fun addCategory(name: String, emoji: String) {
        val c = Store.creds ?: return
        val cat = Category(UUID.randomUUID().toString(), name.trim().take(24), emoji.trim().ifBlank { "📌" }.take(4))
        update { s -> s.copy(categories = s.categories + cat) }
        enqueue("upsert", "plan_categories", JSONObject().put("id", cat.id).put("family_id", c.familyId).put("child_id", c.childId).put("name", cat.name).put("emoji", cat.emoji))
    }

    fun deleteCategory(id: String) {
        update { s -> s.copy(categories = s.categories.filter { it.id != id }) }
        enqueue("delete", "plan_categories?id=eq.$id", null)
    }

    // --- Yerel saklama ve bekleyen işlemler ---

    private fun update(f: (State) -> State) = set(f(_state.value).copy(loaded = true))

    private fun set(s: State) {
        _state.value = s.copy(loaded = true)
        runCatching { Store.prefs().edit().putString("plan.cache", encode(s).toString()).apply() }
        reschedule()
    }

    private fun pending(): JSONArray = runCatching { JSONArray(Store.prefs().getString("plan.pending", "[]")) }.getOrDefault(JSONArray())

    @Synchronized private fun enqueue(op: String, path: String, body: JSONObject?) {
        val q = pending().put(JSONObject().put("op", op).put("path", path).put("body", body ?: JSONObject.NULL))
        Store.prefs().edit().putString("plan.pending", q.toString()).apply()
        Thread { flush() }.start()
    }

    /** Sıradaki işlemleri sunucuya yaz; hata olursa kalanlar sonra tekrar denenir */
    @Synchronized fun flush() {
        val q = pending()
        var i = 0
        while (i < q.length()) {
            val o = q.getJSONObject(i)
            val ok = runCatching {
                if (o.getString("op") == "delete") Api.delete(o.getString("path"))
                else Api.post(o.getString("path"), o.getJSONObject("body"), upsert = true)
            }.onFailure { Log.w(TAG, "plan yazılamadı", it) }
            if (ok.isFailure) {
                val code = (ok.exceptionOrNull() as? Api.ApiError)?.code ?: 0
                if (code == 400 || code == 403 || code == 409 || code == 422) { i++; continue } // kalıcı hata: atla
                break
            }
            i++
        }
        val rest = JSONArray()
        for (j in i until q.length()) rest.put(q.get(j))
        // flush sırasında eklenenleri koru
        val now = pending()
        for (j in q.length() until now.length()) rest.put(now.get(j))
        Store.prefs().edit().putString("plan.pending", rest.toString()).apply()
    }

    private fun encodeItem(i: Item) = JSONObject().put("id", i.id).put("day", i.day.toString()).put("title", i.title)
        .put("category", i.category ?: JSONObject.NULL).put("emoji", i.emoji ?: JSONObject.NULL)
        .put("at", i.at?.toString() ?: JSONObject.NULL).put("remind", i.remind).put("remind_before", i.remindBefore)
        .put("repeat", i.repeat).put("repeat_days", JSONArray(i.repeatDays.sorted())).put("ends_on", i.endsOn?.toString() ?: JSONObject.NULL)

    private fun encode(s: State) = JSONObject()
        .put("items", JSONArray(s.items.map { encodeItem(it).put("created_at", it.createdAt) }))
        .put("checks", JSONArray(s.checks.values.map { JSONObject().put("item_id", it.itemId).put("day", it.day.toString()).put("done", it.done).put("skipped", it.skipped) }))
        .put("categories", JSONArray(s.categories.map { JSONObject().put("id", it.id).put("name", it.name).put("emoji", it.emoji) }))

    private fun str(o: JSONObject, k: String) = o.optString(k).takeIf { !o.isNull(k) && it.isNotBlank() }

    private fun decode(b: JSONObject): State {
        val ia = b.optJSONArray("items") ?: JSONArray()
        val items = (0 until ia.length()).mapNotNull { n ->
            val o = ia.getJSONObject(n)
            runCatching {
                val rd = o.optJSONArray("repeat_days")
                Item(
                    o.getString("id"), LocalDate.parse(o.getString("day")), o.optString("title"), str(o, "category"), str(o, "emoji"),
                    str(o, "at")?.let { Parse.time(it) }, o.optBoolean("remind"), o.optInt("remind_before"), o.optString("repeat", "none"),
                    (0 until (rd?.length() ?: 0)).map { rd!!.optInt(it) }.toSet(), str(o, "ends_on")?.let { LocalDate.parse(it) },
                    o.optString("created_at"),
                )
            }.getOrNull()
        }
        val ca = b.optJSONArray("checks") ?: JSONArray()
        val checks = (0 until ca.length()).mapNotNull { n ->
            val o = ca.getJSONObject(n)
            runCatching { Check(o.getString("item_id"), LocalDate.parse(o.getString("day")), o.optBoolean("done"), o.optBoolean("skipped")) }.getOrNull()
        }.associateBy { key(it.itemId, it.day) }
        val ka = b.optJSONArray("categories") ?: JSONArray()
        val cats = (0 until ka.length()).map { n -> ka.getJSONObject(n).let { Category(str(it, "id"), it.optString("name"), it.optString("emoji", "📌")) } }
        return State(true, items, checks, cats)
    }

    // --- Hatırlatmalar ---

    /** Önümüzdeki hatırlatma anları (saatli, hatırlatması açık, yapılmamış maddeler; 2 gün) */
    fun upcoming(s: State, now: ZonedDateTime): List<Pair<Item, ZonedDateTime>> {
        val out = mutableListOf<Pair<Item, ZonedDateTime>>()
        for (k in 0..1) {
            val d = now.toLocalDate().plusDays(k.toLong())
            for (i in s.forDay(d)) {
                if (!i.remind || i.at == null || s.isDone(i, d)) continue
                val t = d.atTime(i.at).atZone(now.zone).minusMinutes(i.remindBefore.toLong())
                if (t.isAfter(now)) out += i to t
            }
        }
        return out.sortedBy { it.second }
    }

    private const val CODE = 7700

    /** En yakın hatırlatmayı kur (tek alarm; çalınca bir sonrakini kurar) */
    fun reschedule() {
        val ctx = app ?: return
        val am = ctx.getSystemService(AlarmManager::class.java)
        val next = upcoming(_state.value, ZonedDateTime.now(zone())).firstOrNull()
        val sig = next?.let { "${it.first.id}@${it.second.toEpochSecond()}:${it.first.title}" } ?: ""
        val p = Store.prefs()
        if (sig == p.getString("plan.alarmSig", null)) return
        p.edit().putString("plan.alarmSig", sig).apply()
        val old = PendingIntent.getBroadcast(ctx, CODE, Intent(ctx, PlanReceiver::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE)
        old?.let { am.cancel(it) }
        next ?: return
        val (item, at) = next
        val day = at.plusMinutes(item.remindBefore.toLong()).toLocalDate()
        val pi = PendingIntent.getBroadcast(ctx, CODE, PlanReceiver.fire(ctx, item, day), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        runCatching {
            if (android.os.Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at.toInstant().toEpochMilli(), pi)
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at.toInstant().toEpochMilli(), pi)
        }.onFailure { Log.w(TAG, "hatırlatma kurulamadı", it) }
    }

    /** Ertele: X dk sonra aynı madde için tekrar hatırlat */
    fun snooze(ctx: Context, id: String, title: String, day: String, minutes: Int = 10) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        val i = Intent(ctx, PlanReceiver::class.java).setAction(PlanReceiver.ACT_FIRE).putExtra("id", id).putExtra("title", title).putExtra("day", day)
        val pi = PendingIntent.getBroadcast(ctx, CODE + 1 + (id.hashCode() and 0xff), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        runCatching { am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + minutes * 60_000L, pi) }
    }
}
