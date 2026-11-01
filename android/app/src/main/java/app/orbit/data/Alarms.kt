package app.orbit.data

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import app.orbit.service.AlarmReceiver
import app.orbit.ui.MainActivity
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

/** Alarm / hatırlatıcı (ebeveynin ya da çocuğun kurduğu). */
data class AlarmDef(
    val id: String,
    val title: String,
    val kind: String,
    val time: LocalTime,
    /** 1 = Pzt … 7 = Paz; boşsa tek seferlik (onDate) */
    val days: Set<Int>,
    val onDate: LocalDate?,
    val active: Boolean,
    val byParent: Boolean,
    val canEdit: Boolean,
    val canDelete: Boolean,
    val snoozeMax: Int,
    val snoozeMinutes: Int,
) {
    val editable get() = !byParent || canEdit
    val deletable get() = !byParent || canDelete

    /** Bir sonraki çalma zamanı (yoksa null) */
    fun next(now: ZonedDateTime): ZonedDateTime? {
        if (!active) return null
        if (days.isEmpty()) {
            val d = onDate ?: return null
            val t = d.atTime(time).atZone(now.zone)
            return if (t.isAfter(now)) t else null
        }
        for (i in 0..7) {
            val d = now.toLocalDate().plusDays(i.toLong())
            if (d.dayOfWeek.value !in days) continue
            val t = d.atTime(time).atZone(now.zone)
            if (t.isAfter(now)) return t
        }
        return null
    }
}

object Alarms {
    private const val TAG = "OrbitAlarms"
    @Volatile private var app: Context? = null

    fun init(ctx: Context) { app = ctx.applicationContext }

    fun list(): List<AlarmDef> {
        val b = Store.rulesJson?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return emptyList()
        return parse(b.optJSONArray("alarms"))
    }

    fun parse(a: JSONArray?): List<AlarmDef> = (0 until (a?.length() ?: 0)).mapNotNull { i ->
        val o = a!!.getJSONObject(i)
        runCatching {
            val days = o.optJSONArray("days")
            AlarmDef(
                o.getString("id"), o.optString("title"), o.optString("kind", "alarm"),
                Parse.time(o.getString("at_time")),
                (0 until (days?.length() ?: 0)).map { days!!.optInt(it) }.toSet(),
                if (o.isNull("on_date")) null else Parse.date(o.optString("on_date")),
                o.optBoolean("active", true), o.optBoolean("by_parent"),
                o.optBoolean("child_can_edit", true), o.optBoolean("child_can_delete", true),
                o.optInt("snooze_max", 3), o.optInt("snooze_minutes", 5),
            )
        }.getOrNull()
    }

    private fun pi(ctx: Context, a: AlarmDef, snoozes: Int, code: Int): PendingIntent {
        val i = Intent(ctx, AlarmReceiver::class.java)
            .putExtra("id", a.id).putExtra("title", a.title).putExtra("kind", a.kind)
            .putExtra("snoozeMax", a.snoozeMax).putExtra("snoozeMinutes", a.snoozeMinutes).putExtra("snoozes", snoozes)
        return PendingIntent.getBroadcast(ctx, code, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** Tüm alarmları bir sonraki zamanlarına kur (kurallar her yenilendiğinde; değişmediyse dokunmaz). */
    fun reschedule(force: Boolean = false) {
        val ctx = app ?: return
        val am = ctx.getSystemService(AlarmManager::class.java)
        val now = ZonedDateTime.now(ZoneId.systemDefault())
        val list = list()
        val plan = list.mapNotNull { a -> a.next(now)?.let { a to it } }
        val sig = plan.joinToString("|") { "${it.first.id}@${it.second.toEpochSecond()}:${it.first.title}:${it.first.kind}" }
        val p = Store.prefs()
        if (!force && sig == p.getString("alarmSig", null)) return
        // Eskileri iptal et
        for (code in p.getStringSet("alarmCodes", emptySet())!!) {
            runCatching {
                val old = PendingIntent.getBroadcast(ctx, code.toInt(), Intent(ctx, AlarmReceiver::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE)
                old?.let { am.cancel(it) }
            }
        }
        val codes = mutableSetOf<String>()
        for ((a, at) in plan) {
            val code = 8000 + (a.id.hashCode() and 0xffff)
            val show = PendingIntent.getActivity(ctx, code, Intent(ctx, MainActivity::class.java).putExtra(Notifier.EXTRA_SCREEN, "ALARMS"), PendingIntent.FLAG_IMMUTABLE)
            runCatching { am.setAlarmClock(AlarmManager.AlarmClockInfo(at.toInstant().toEpochMilli(), show), pi(ctx, a, 0, code)) }
                .onFailure { Log.w(TAG, "alarm kurulamadı", it) }
            codes += code.toString()
        }
        p.edit().putString("alarmSig", sig).putStringSet("alarmCodes", codes).apply()
    }

    /** Ertele: X dk sonra tekrar çal */
    fun snooze(ctx: Context, id: String, title: String, kind: String, snoozeMax: Int, snoozeMinutes: Int, snoozes: Int) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        val a = AlarmDef(id, title, kind, LocalTime.now(), emptySet(), null, true, false, true, true, snoozeMax, snoozeMinutes)
        val at = System.currentTimeMillis() + snoozeMinutes * 60_000L
        val code = 9000 + (id.hashCode() and 0xffff)
        runCatching { am.setAlarmClock(AlarmManager.AlarmClockInfo(at, null), pi(ctx, a, snoozes, code)) }
    }

    // --- Sunucu (IO iş parçacığında) ---

    fun save(id: String?, title: String, kind: String, time: LocalTime, days: Set<Int>, onDate: LocalDate?, active: Boolean): Boolean {
        val c = Store.creds ?: return false
        val body = JSONObject().put("title", title.trim().ifBlank { "Alarm" }.take(60)).put("kind", kind)
            .put("at_time", time.toString()).put("days", JSONArray(days.sorted()))
            .put("on_date", onDate?.toString() ?: JSONObject.NULL).put("active", active)
        return runCatching {
            if (id == null) Api.post("alarms", body.put("family_id", c.familyId).put("child_id", c.childId))
            else Api.patch("alarms?id=eq.$id", body)
            true
        }.getOrElse { Log.w(TAG, "kaydedilemedi", it); false }
    }

    fun delete(id: String): Boolean = runCatching { Api.delete("alarms?id=eq.$id"); true }.getOrElse { Log.w(TAG, "silinemedi", it); false }

    /** Çaldı kaydı; dönen id ile sonra kapatma/erteleme işlenir */
    fun logFired(alarmId: String, title: String): String? {
        val c = Store.creds ?: return null
        return runCatching {
            Api.post("alarm_log", JSONObject().put("alarm_id", alarmId).put("child_id", c.childId).put("title", title))
            Api.get("alarm_log?alarm_id=eq.$alarmId&select=id&order=fired_at.desc&limit=1").optJSONObject(0)?.optString("id")
        }.getOrNull()
    }

    fun logDismiss(logId: String?, snoozes: Int) {
        logId ?: return
        runCatching { Api.patch("alarm_log?id=eq.$logId", JSONObject().put("dismissed_at", Instant.now().toString()).put("snoozes", snoozes)) }
    }
}
