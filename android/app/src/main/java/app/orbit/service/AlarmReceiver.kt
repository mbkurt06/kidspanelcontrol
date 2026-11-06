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
import app.orbit.data.Alarms
import app.orbit.data.Notifier
import app.orbit.data.Store
import app.orbit.ui.AlarmActivity
import kotlin.concurrent.thread

/** Alarm zamanı geldi: alarm ise tam ekran çalar, hatırlatıcı ise sesli bildirim. Sonra bir sonrakini kurar. */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Store.init(context)
        Alarms.init(context)
        Notifier.init(context)
        val id = intent.getStringExtra("id") ?: return
        val title = intent.getStringExtra("title") ?: "Alarm"
        val kind = intent.getStringExtra("kind") ?: "alarm"
        val snoozes = intent.getIntExtra("snoozes", 0)
        val nm = context.getSystemService(NotificationManager::class.java)
        channels(context, nm)
        val noteId = 9500 + (id.hashCode() and 0xfff)

        if (kind == "reminder") {
            // Seçilmiş ses varsa sessiz kanaldan bildirim + sesi kendimiz bir kez çalarız
            val snd = Alarms.list().firstOrNull { it.id == id }?.sound
            val custom = snd?.uri != null
            if (custom) runCatching { reminderPlayer?.stop(); reminderPlayer = app.orbit.data.SoundPlayer(context.applicationContext).also { it.playOnce(snd!!.uri!!, snd.volume) } }
            val open = PendingIntent.getActivity(
                context, noteId,
                Intent(context, app.orbit.ui.MainActivity::class.java).putExtra(Notifier.EXTRA_SCREEN, "ALARMS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE,
            )
            nm.notify(noteId, Notification.Builder(context, if (custom) CH_REMIND_QUIET else CH_REMIND)
                .setSmallIcon(R.drawable.ic_orbit).setContentTitle("🔔 $title").setContentText("Hatırlatma")
                .setCategory(Notification.CATEGORY_REMINDER).setContentIntent(open).setAutoCancel(true).build())
        } else {
            val full = Intent(context, AlarmActivity::class.java)
                .putExtras(intent).putExtra("noteId", noteId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
            val fpi = PendingIntent.getActivity(context, noteId, full, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            nm.notify(noteId, Notification.Builder(context, CH_ALARM)
                .setSmallIcon(R.drawable.ic_orbit).setContentTitle("⏰ $title").setContentText("Alarm çalıyor")
                .setCategory(Notification.CATEGORY_ALARM).setFullScreenIntent(fpi, true).setContentIntent(fpi).setOngoing(true).build())
            runCatching { context.startActivity(full) }
        }

        // Çaldı kaydı ve bir sonraki alarm
        val pending = goAsync()
        thread {
            try {
                if (snoozes == 0) Alarms.logFired(id, title)?.let { Store.prefs().edit().putString("alarmLog:$id", it).apply() }
                Alarms.reschedule(force = true)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val CH_ALARM = "orbit-alarm"
        const val CH_REMIND = "orbit-remind"
        const val CH_REMIND_QUIET = "orbit-remind-custom"
        /** Çalan hatırlatıcı sesi (çöp toplayıcı kesmesin diye burada tutulur) */
        @Volatile var reminderPlayer: app.orbit.data.SoundPlayer? = null

        fun channels(ctx: Context, nm: NotificationManager = ctx.getSystemService(NotificationManager::class.java)) {
            nm.createNotificationChannel(NotificationChannel(CH_ALARM, "Alarmlar", NotificationManager.IMPORTANCE_HIGH).apply {
                setSound(null, null) // ses AlarmActivity'de çalar
                setBypassDnd(true)
            })
            nm.createNotificationChannel(NotificationChannel(CH_REMIND_QUIET, "Hatırlatıcılar (seçilen ses)", NotificationManager.IMPORTANCE_HIGH).apply {
                setSound(null, null) // ses AlarmReceiver'da çalar
            })
            nm.createNotificationChannel(NotificationChannel(CH_REMIND, "Hatırlatıcılar", NotificationManager.IMPORTANCE_HIGH).apply {
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT).build(),
                )
            })
        }
    }
}
