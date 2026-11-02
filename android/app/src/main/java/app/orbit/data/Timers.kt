package app.orbit.data

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/** Odak profili: sayaç çalışırken telefonda açık kalabilecekler (kuralların üstüne sadece kısıtlar). */
data class FocusProfile(
    val id: String,
    val name: String,
    val icon: String?,
    val groups: Set<String>,
    val packages: Set<String>,
    val messagesAllowed: Boolean,
    val callsAllowed: Boolean,
    val screens: Set<String>,
)

data class ActivityDef(val id: String, val name: String, val icon: String?, val defaultFocusId: String?)

/** Bir sayaç (çalışma oturumu). Zamanlar epoch ms. */
data class TimerSession(
    val id: String,
    val title: String,
    val icon: String?,
    val activityId: String?,
    val kind: String,
    val plannedSeconds: Int?,
    val focusId: String?,
    val startedBy: String,
    val allowStop: String,
    val pauseMode: String,
    val pauseMaxMinutes: Int?,
    val focusChange: String,
    val status: String,
    val startedAt: Long,
    val pausedAt: Long?,
    val pausedSeconds: Int,
    val focusedSeconds: Int,
    val awaySeconds: Int,
) {
    val running get() = status == "running"
    val active get() = status == "running" || status == "paused"
    val byParent get() = startedBy == "parent"

    /** Geçen çalışma süresi (molalar hariç), saniye */
    fun elapsed(now: Long = System.currentTimeMillis()): Long {
        val pausedNow = if (status == "paused" && pausedAt != null) (now - pausedAt) / 1000 else 0
        return ((now - startedAt) / 1000 - pausedSeconds - pausedNow).coerceAtLeast(0)
    }

    /** Geri sayımda kalan, saniye (kronometrede null) */
    fun remaining(now: Long = System.currentTimeMillis()): Long? = plannedSeconds?.let { (it - elapsed(now)).coerceAtLeast(0) }

    val canStop get() = !byParent || allowStop != "no"
    val canPause get() = !byParent || pauseMode != "none"
    val canChangeFocus get() = !byParent || focusChange != "no"
}

/** Sayaçlar: kurallar paketinden okunur, telefondan başlatılır/durdurulur. */
object Timers {
    private const val TAG = "OrbitTimers"

    private fun bundle(): JSONObject? = Store.rulesJson?.let { runCatching { JSONObject(it) }.getOrNull() }
    private fun JSONObject.s(k: String): String? = if (isNull(k) || !has(k)) null else optString(k).ifBlank { null }
    private fun JSONObject.i(k: String): Int? = if (isNull(k) || !has(k)) null else optInt(k)

    fun profiles(b: JSONObject? = bundle()): Map<String, FocusProfile> {
        val a = b?.optJSONArray("focus_profiles") ?: return emptyMap()
        return (0 until a.length()).map { a.getJSONObject(it) }.associate { o ->
            o.getString("id") to FocusProfile(
                o.getString("id"), o.optString("name"), o.s("icon"),
                strings(o.optJSONArray("allowed_groups")).toSet(), strings(o.optJSONArray("allowed_packages")).toSet(),
                o.optBoolean("messages_allowed", true), o.optBoolean("calls_allowed", true),
                strings(o.optJSONArray("allowed_screens")).toSet(),
            )
        }
    }

    fun activities(b: JSONObject? = bundle()): List<ActivityDef> {
        val a = b?.optJSONArray("activities") ?: return emptyList()
        return (0 until a.length()).map { a.getJSONObject(it) }.map { o -> ActivityDef(o.getString("id"), o.optString("name"), o.s("icon"), o.s("default_focus_id")) }
    }

    fun parseSessions(a: JSONArray?): List<TimerSession> = (0 until (a?.length() ?: 0)).mapNotNull { idx ->
        val o = a!!.getJSONObject(idx)
        runCatching {
            TimerSession(
                o.getString("id"), o.optString("title"), o.s("icon"), o.s("activity_id"), o.optString("kind", "countdown"),
                o.i("planned_seconds"), o.s("focus_id"), o.optString("started_by", "child"),
                o.optString("allow_stop", "yes"), o.optString("pause_mode", "child"), o.i("pause_max_minutes"), o.optString("focus_change", "free"),
                o.optString("status"), Parse.ts(o.s("started_at")) ?: 0L, Parse.ts(o.s("paused_at")),
                o.optInt("paused_seconds"), o.optInt("focused_seconds"), o.optInt("away_seconds"),
            )
        }.getOrNull()
    }

    /** Şu an çalışan ya da molada olan sayaç */
    fun active(b: JSONObject? = bundle()): TimerSession? = parseSessions(b?.optJSONArray("timer_sessions")).firstOrNull { it.active }

    /** Şu an geçerli odak profili (sayaç çalışıyorsa; molada odak kalkar) */
    fun activeFocus(b: JSONObject? = bundle()): FocusProfile? {
        val s = active(b) ?: return null
        if (!s.running) return null
        return s.focusId?.let { profiles(b)[it] }
    }

    private fun strings(a: JSONArray?): List<String> = (0 until (a?.length() ?: 0)).map { a!!.optString(it) }

    // --- İşlemler (ağ; IO iş parçacığında çağrılır) ---

    fun start(title: String, icon: String?, activityId: String?, plannedMinutes: Int?, focusId: String?): Boolean {
        val c = Store.creds ?: return false
        return runCatching {
            Api.post("timer_sessions", JSONObject()
                .put("family_id", c.familyId).put("child_id", c.childId)
                .put("title", title.trim().ifBlank { "Çalışma" }.take(60)).put("icon", icon ?: JSONObject.NULL)
                .put("activity_id", activityId ?: JSONObject.NULL)
                .put("kind", if (plannedMinutes != null) "countdown" else "stopwatch")
                .put("planned_seconds", plannedMinutes?.let { it * 60 } ?: JSONObject.NULL)
                .put("focus_id", focusId ?: JSONObject.NULL)
                .put("started_by", "child"))
            true
        }.getOrElse { Log.w(TAG, "başlatılamadı", it); false }
    }

    private fun patch(id: String, body: JSONObject): Boolean =
        runCatching { Api.patch("timer_sessions?id=eq.$id", body); true }.getOrElse { Log.w(TAG, "güncellenemedi", it); false }

    fun pause(s: TimerSession) = patch(s.id, JSONObject().put("status", "paused").put("paused_at", Instant.now().toString()))

    fun resume(s: TimerSession): Boolean {
        val extra = s.pausedAt?.let { ((System.currentTimeMillis() - it) / 1000).toInt() } ?: 0
        return patch(s.id, JSONObject().put("status", "running").put("paused_at", JSONObject.NULL).put("paused_seconds", s.pausedSeconds + extra))
    }

    /** Bitir (kaydet): geri sayım dolmadıysa "stopped", kronometre ya da süre dolduysa "done" */
    fun finish(s: TimerSession, by: String = "child", counts: Pair<Int, Int>? = null): Boolean {
        val done = s.kind == "stopwatch" || (s.remaining() ?: 0) <= 0
        val body = JSONObject().put("status", if (done) "done" else "stopped").put("ended_at", Instant.now().toString()).put("ended_by", by)
        counts?.let { body.put("focused_seconds", it.first).put("away_seconds", it.second) }
        if (s.status == "paused" && s.pausedAt != null) body.put("paused_seconds", s.pausedSeconds + ((System.currentTimeMillis() - s.pausedAt) / 1000).toInt())
        return patch(s.id, body)
    }

    fun cancel(s: TimerSession, counts: Pair<Int, Int>? = null): Boolean {
        val body = JSONObject().put("status", "cancelled").put("ended_at", Instant.now().toString()).put("ended_by", "child")
        counts?.let { body.put("focused_seconds", it.first).put("away_seconds", it.second) }
        return patch(s.id, body)
    }

    fun changeFocus(s: TimerSession, focusId: String?) = patch(s.id, JSONObject().put("focus_id", focusId ?: JSONObject.NULL))

    fun pushCounts(id: String, focused: Int, away: Int) = patch(id, JSONObject().put("focused_seconds", focused).put("away_seconds", away))

    /** Bugünkü sayaçlar (geçmiş listesi için) */
    fun today(): List<TimerSession> {
        val c = Store.creds ?: return emptyList()
        val since = java.time.LocalDate.now().atStartOfDay(java.time.ZoneId.systemDefault()).toInstant().toString()
        return runCatching {
            parseSessions(Api.get("timer_sessions?child_id=eq.${c.childId}&started_at=gte.$since&select=*&order=started_at.desc&limit=30"))
        }.getOrDefault(emptyList())
    }

    // --- Odaklı / uzak süre sayımı (servis her saniye çağırır) ---
    private var countsFor: String? = null
    private var focused = 0L
    private var away = 0L
    private var lastPush = 0L

    /** onFocusApp: ön plandaki uygulama odak için uygun mu (ya da ekran kapalı/Orbit). */
    fun tick(s: TimerSession?, dt: Long, onFocusApp: Boolean): Pair<Int, Int>? {
        if (s == null || !s.running) return null
        if (countsFor != s.id) { countsFor = s.id; focused = s.focusedSeconds.toLong(); away = s.awaySeconds.toLong() }
        if (onFocusApp) focused += dt else away += dt
        return focused.toInt() to away.toInt()
    }

    fun shouldPush(now: Long): Boolean = if (now - lastPush > 30_000) { lastPush = now; true } else false
    fun currentCounts(id: String): Pair<Int, Int>? = if (countsFor == id) focused.toInt() to away.toInt() else null
}
