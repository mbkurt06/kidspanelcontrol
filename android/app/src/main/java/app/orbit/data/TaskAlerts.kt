package app.orbit.data

import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalTime

/** Görev değişikliklerini bildirime çevirir: yeni görev, onay, tekrar yap, saat hatırlatması. */
object TaskAlerts {
    private const val KEY = "taskSeen"

    /** Kurallar yenilenince çağrılır. İlk çalıştırmada sadece mevcut durumu kaydeder. */
    fun onTasks(tasks: List<TaskItem>) {
        val p = Store.prefs()
        val first = !p.contains(KEY)
        val seen = runCatching { JSONObject(p.getString(KEY, "{}")!!) }.getOrDefault(JSONObject())
        val next = JSONObject()
        for (t in tasks) {
            next.put(t.runId, t.status)
            if (first) continue
            val before = if (seen.has(t.runId)) seen.optString(t.runId) else null
            if (before == t.status) continue
            val id = 7100 + (t.runId.hashCode() and 0xfff)
            val reward = t.rewardMinutes?.let { " (+$it dk)" } ?: ""
            when {
                before == null && t.open ->
                    Notifier.show(Notifier.CH_TASKS, id, "📋 Yeni görev", t.title + reward, "TASKS")
                t.status == "approved" ->
                    Notifier.show(Notifier.CH_TASKS, id, "✅ Onaylandı", t.title + (t.rewardMinutes?.let { " · +$it dk kazandın" } ?: "") + (t.rewardText?.let { " · $it" } ?: ""), "TASKS")
                t.status == "rejected" ->
                    Notifier.show(Notifier.CH_TASKS, id, "🔁 Tekrar yapmalısın", t.title + (t.rejectNote?.let { " · Not: $it" } ?: ""), "TASKS")
            }
        }
        p.edit().putString(KEY, next.toString()).apply()
    }

    /** Saatli görevler için bitişten 30 dk önce bir kez hatırlat (servis dakikada bir çağırır). */
    fun remind(tasks: List<TaskItem>, today: LocalDate, now: LocalTime) {
        val p = Store.prefs()
        for (t in tasks) {
            if (!t.open) continue
            val due = t.dueTime?.let { runCatching { LocalTime.parse(it.take(5)) }.getOrNull() } ?: continue
            if (t.dueDate != null && t.dueDate.take(10) != today.toString()) continue
            val mins = java.time.Duration.between(now, due).toMinutes()
            if (mins !in 0..30) continue
            val key = "remind:${t.runId}:$today"
            if (p.getBoolean(key, false)) continue
            p.edit().putBoolean(key, true).apply()
            Notifier.show(Notifier.CH_TASKS, 7200 + (t.runId.hashCode() and 0xfff), "⏰ $mins dk kaldı", "${t.title} · ${due.toString().take(5)}'e kadar", "TASKS")
        }
    }
}
