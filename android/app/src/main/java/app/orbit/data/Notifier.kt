package app.orbit.data

import android.app.Notification
import app.orbit.ui.NotifyOpenActivity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import app.orbit.R
import app.orbit.ui.MainActivity
import app.orbit.ui.RecordActivity

/** Çocuğun telefonunda görev ve mesaj bildirimleri. Dokununca Orbit'in ilgili ekranı açılır. */
object Notifier {
    const val CH_TASKS = "orbit-tasks"
    const val CH_MSG = "orbit-messages"
    const val EXTRA_SCREEN = "screen"
    @Volatile private var app: Context? = null

    fun init(ctx: Context) {
        if (app != null) return
        app = ctx.applicationContext
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_TASKS, "Görevler", NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(CH_MSG, "Ebeveyn mesajları", NotificationManager.IMPORTANCE_HIGH))
    }

    fun show(channel: String, id: Int, title: String, text: String, screen: String) {
        val ctx = app ?: return
        val open = Intent(ctx, NotifyOpenActivity::class.java)
            .putExtra(EXTRA_SCREEN, screen)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pi = PendingIntent.getActivity(ctx, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = Notification.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_orbit)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        runCatching { ctx.getSystemService(NotificationManager::class.java).notify(id, n) }
    }

    /** Kayıt beklenmedik durdu: dokununca kayıt ekranı açılır (oradan devam edilir). */
    fun recordingStopped(ctx: Context, runId: String, title: String) {
        val open = Intent(ctx, RecordActivity::class.java)
            .putExtra("runId", runId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = PendingIntent.getActivity(ctx, 77, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = Notification.Builder(ctx, CH_TASKS)
            .setSmallIcon(R.drawable.ic_orbit)
            .setContentTitle("📹 Kayıt durdu")
            .setContentText("$title — devam etmek için dokun")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        runCatching { ctx.getSystemService(NotificationManager::class.java).notify(77, n) }
    }

    /** Ekran kaydı sistemden durdu: dokununca Orbit açılır, "Ekran kaydına devam et" ile kaldığı yerden sürer */
    fun screenStopped(ctx: Context, title: String) {
        val open = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        val pi = PendingIntent.getActivity(ctx, 78, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = Notification.Builder(ctx, CH_TASKS)
            .setSmallIcon(R.drawable.ic_orbit)
            .setContentTitle("🎬 Ekran kaydı durdu")
            .setContentText("$title — kaldığı yerden devam etmek için dokun")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        runCatching { ctx.getSystemService(NotificationManager::class.java).notify(78, n) }
    }

    fun cancel(id: Int) {
        val ctx = app ?: return
        runCatching { ctx.getSystemService(NotificationManager::class.java).cancel(id) }
    }
}
