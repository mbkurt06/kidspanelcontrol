package app.orbit.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import app.orbit.R
import app.orbit.data.Notifier
import app.orbit.data.Plan
import app.orbit.data.Store
import java.time.LocalDate
import kotlin.concurrent.thread

/** Planım hatırlatması: bildirim (Yaptım / 10 dk ertele) ve bir sonrakini kurar. */
class PlanReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Store.init(context)
        Plan.init(context)
        val id = intent.getStringExtra("id") ?: return
        val title = intent.getStringExtra("title") ?: "Planım"
        val day = intent.getStringExtra("day") ?: Plan.today().toString()
        val nm = context.getSystemService(NotificationManager::class.java)
        val noteId = NOTE + (id.hashCode() and 0xfff)
        when (intent.action) {
            ACT_DONE -> {
                nm.cancel(noteId)
                val item = Plan.state.value.items.firstOrNull { it.id == id }
                val pending = goAsync()
                thread { try { if (item != null) Plan.setDone(item, LocalDate.parse(day), true); Plan.flush() } finally { pending.finish() } }
                return
            }
            ACT_SNOOZE -> {
                nm.cancel(noteId)
                Plan.snooze(context, id, title, day)
                return
            }
        }
        // Yapıldıysa ya da silindiyse hatırlatma
        val st = Plan.state.value
        val item = st.items.firstOrNull { it.id == id }
        val d = runCatching { LocalDate.parse(day) }.getOrDefault(Plan.today())
        if (item == null || st.isDone(item, d) || !item.occursOn(d)) { Store.prefs().edit().remove("plan.alarmSig").apply(); Plan.reschedule(); return }
        channel(nm)
        val open = PendingIntent.getActivity(
            context, noteId,
            Intent(context, app.orbit.ui.MainActivity::class.java).putExtra(Notifier.EXTRA_SCREEN, "PLAN").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        fun act(a: String) = PendingIntent.getBroadcast(
            context, noteId + a.hashCode(),
            Intent(context, PlanReceiver::class.java).setAction(a).putExtra("id", id).putExtra("title", title).putExtra("day", day),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val time = item.at?.toString()?.take(5)?.let { "$it · " } ?: ""
        nm.notify(noteId, Notification.Builder(context, CH)
            .setSmallIcon(R.drawable.ic_orbit)
            .setContentTitle("🔔 $time${item.emoji?.let { "$it " } ?: ""}${item.title}")
            .setContentText(if (item.remindBefore > 0) "${item.remindBefore} dk sonra" else "Şimdi")
            .setCategory(Notification.CATEGORY_REMINDER).setContentIntent(open).setAutoCancel(true)
            .addAction(Notification.Action.Builder(null, "Yaptım ☑", act(ACT_DONE)).build())
            .addAction(Notification.Action.Builder(null, "10 dk ertele", act(ACT_SNOOZE)).build())
            .build())
        Store.prefs().edit().remove("plan.alarmSig").apply()
        Plan.reschedule()
    }

    companion object {
        const val CH = "orbit-plan"
        const val NOTE = 6200
        const val ACT_FIRE = "app.orbit.PLAN_FIRE"
        const val ACT_DONE = "app.orbit.PLAN_DONE"
        const val ACT_SNOOZE = "app.orbit.PLAN_SNOOZE"

        fun fire(ctx: Context, item: Plan.Item, day: LocalDate): Intent =
            Intent(ctx, PlanReceiver::class.java).setAction(ACT_FIRE).putExtra("id", item.id).putExtra("title", item.title).putExtra("day", day.toString())

        fun channel(nm: NotificationManager) {
            nm.createNotificationChannel(NotificationChannel(CH, "Planım hatırlatmaları", NotificationManager.IMPORTANCE_HIGH).apply {
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT).build(),
                )
            })
        }
    }
}
