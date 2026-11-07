package app.orbit.ui

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.ContextCompat
import app.orbit.data.TaskItem
import app.orbit.service.ScreenCaptureService

/**
 * Ekran yakalama izni (Android her seferinde sorar) → [ScreenCaptureService] yüzen düğmeyle başlar.
 * mode = shot (ekran görüntüsü) | record (ekran kaydı)
 */
class ScreenCaptureActivity : Activity() {
    companion object {
        private const val REQ = 41

        fun start(ctx: Context, t: TaskItem, mode: String) {
            // Android Go'da bu izin hiç yok: bildirimden kontrol edilir, izin sayfası açılmaz
            val lowRam = ctx.getSystemService(android.app.ActivityManager::class.java).isLowRamDevice
            if (!Settings.canDrawOverlays(ctx) && !lowRam) {
                Toast.makeText(ctx, "Önce Orbit'e \"diğer uygulamaların üzerinde göster\" izni ver", Toast.LENGTH_LONG).show()
                runCatching {
                    ctx.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                return
            }
            // Tam kilitteyse ekran sabitlemeyi bırak: sistem izin penceresi ancak böyle açılır.
            // Kilit yine sürer: Orbit ve görevin izinli uygulamaları dışındakiler kapalı kalır.
            ScreenCaptureService.preparingUntil = System.currentTimeMillis() + 90_000
            (ctx as? Activity)?.let { a ->
                val am = a.getSystemService(android.app.ActivityManager::class.java)
                if (am.lockTaskModeState != android.app.ActivityManager.LOCK_TASK_MODE_NONE) runCatching { a.stopLockTask() }
            }
            app.orbit.service.Live.syncRequested = true
            val i = Intent(ctx, ScreenCaptureActivity::class.java)
                .putExtra("mode", mode)
                .putExtra("runId", t.runId)
                .putExtra("title", t.title)
                .putExtra("shotCount", t.screenshotCount)
                .putExtra("shotMin", t.screenshotMin ?: 1)
                .putExtra("shotMax", t.screenshotMax ?: t.screenshotMin ?: 1)
                .putExtra("recMax", (t.screenRecMinutes ?: 30) * 60)
                .putExtra("recMin", (t.screenRecMinMinutes ?: 0) * 60)
                .putExtra("autoSubmit", t.proof == "none" && t.recordMinutes == null && (mode == "record" && t.screenshotMin == null || mode == "shot" && t.screenRecMinutes == null))
                .putExtra("openPkg", t.allowedPackages.firstOrNull())
                .putStringArrayListExtra("allowed", ArrayList(if (mode == "record") t.allowedPackages else emptyList()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ctx.startActivity(i)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val mpm = getSystemService(MediaProjectionManager::class.java)
        runCatching { startActivityForResult(mpm.createScreenCaptureIntent(), REQ) }
            .onFailure { Toast.makeText(this, "Ekran yakalama açılamadı", Toast.LENGTH_LONG).show(); finish() }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ && resultCode == RESULT_OK && data != null) {
            val svc = Intent(this, ScreenCaptureService::class.java)
                .putExtras(intent)
                .putExtra("resultCode", resultCode)
                .putExtra("data", data)
            ContextCompat.startForegroundService(this, svc)
            // Görev uygulamasını aç (ör. Duolingo)
            intent.getStringExtra("openPkg")?.let { pkg ->
                packageManager.getLaunchIntentForPackage(pkg)?.let { runCatching { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
            }
        } else if (requestCode == REQ) {
            ScreenCaptureService.preparingUntil = 0L
            Toast.makeText(this, "İzin verilmedi", Toast.LENGTH_SHORT).show()
        }
        finish()
    }
}
