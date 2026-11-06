package app.orbit.ui

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Log
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.R
import app.orbit.data.SoundPlayer
import app.orbit.data.Store
import app.orbit.data.Sync
import org.json.JSONObject
import java.time.Instant

/**
 * Telefonu bul: ebeveyn panelden çaldırır. Sessiz / titreşimde de seçilen seviyede çalar;
 * "Buldum", panelden "Durdur" ya da 2 dk sonra durur. Ses seviyesi çalarken panelden değiştirilebilir.
 */
object FindPhone {
    private const val TAG = "OrbitFind"
    private const val CH = "orbit-find"
    private const val NOTE = 9701
    private val seen = java.util.Collections.synchronizedSet(mutableSetOf<String>())
    @Volatile var active: FindPhoneActivity? = null
    @Volatile var volume: Int = 60
    @Volatile var ringing = false

    /** Panel komutu (resync + payload.find): start | volume | stop. 10 dk'dan eskiler yok sayılır. */
    fun handle(ctx: Context, cmdId: String, payload: JSONObject, createdAt: String?) {
        if (!seen.add(cmdId)) return
        val at = createdAt?.let { runCatching { Instant.parse(it.replace(" ", "T").let { s -> if (s.endsWith("Z") || s.contains("+")) s else s + "Z" }) }.getOrNull() }
        if (at != null && at.isBefore(Instant.now().minusSeconds(600))) return
        val v = payload.optInt("volume", volume).coerceIn(5, 100)
        when (payload.optString("find")) {
            "start" -> { volume = v; start(ctx) }
            "volume" -> { volume = v; active?.setLevel(v) }
            "stop" -> active?.done("stopped") ?: report("stopped")
        }
    }

    private fun start(ctx: Context) {
        val a = active
        if (a != null) { a.setLevel(volume); return }
        val i = Intent(ctx, FindPhoneActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH, "Telefonu bul", NotificationManager.IMPORTANCE_HIGH).apply { setSound(null, null); setBypassDnd(true) })
        val pi = PendingIntent.getActivity(ctx, NOTE, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        nm.notify(NOTE, Notification.Builder(ctx, CH).setSmallIcon(R.drawable.ic_orbit).setContentTitle("📍 Telefon aranıyor")
            .setContentText("Ebeveynin telefonu çaldırıyor").setCategory(Notification.CATEGORY_ALARM).setFullScreenIntent(pi, true).setContentIntent(pi).setOngoing(true).build())
        runCatching { ctx.startActivity(i) }.onFailure { Log.w(TAG, "açılamadı", it) }
    }

    fun cancelNote(ctx: Context) = runCatching { ctx.getSystemService(NotificationManager::class.java).cancel(NOTE) }

    fun report(state: String) {
        Thread { Sync.event("find_phone", JSONObject().put("state", state).put("volume", volume)) }.start()
    }
}

class FindPhoneActivity : ComponentActivity() {
    private lateinit var sound: SoundPlayer
    private var vibrator: Vibrator? = null
    private var finished = false
    private val timeout = Runnable { done("timeout") }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Store.init(this)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        FindPhone.active = this
        sound = SoundPlayer(this)
        sound.start(null, FindPhone.volume, ramp = false)
        runCatching {
            vibrator = getSystemService(Vibrator::class.java)
            vibrator?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 700, 500), 0))
        }
        FindPhone.ringing = true
        FindPhone.report("ringing")
        window.decorView.postDelayed(timeout, 2 * 60_000L)
        setContent {
            OrbitTheme {
                Column(
                    Modifier.fillMaxSize().background(C.bg).safeDrawingPadding().padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(18.dp, Alignment.CenterVertically),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("📍", fontSize = 80.sp)
                    Text("Telefon aranıyor", color = C.text, fontSize = 28.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                    Muted("Ebeveynin bu telefonu çaldırıyor.", 15)
                    Button(
                        onClick = { done("found") },
                        modifier = Modifier.fillMaxWidth().height(72.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = C.accent),
                    ) { Text("📍 Buldum", fontSize = 22.sp) }
                }
            }
        }
    }

    fun setLevel(pct: Int) = runOnUiThread { if (!finished) sound.setVolume(pct) }

    fun done(state: String) = runOnUiThread {
        if (finished) return@runOnUiThread
        finished = true
        FindPhone.report(state)
        finish()
    }

    override fun onDestroy() {
        window.decorView.removeCallbacks(timeout)
        if (!finished) { finished = true; FindPhone.report("stopped") }
        sound.stop()
        runCatching { vibrator?.cancel() }
        FindPhone.cancelNote(this)
        FindPhone.ringing = false
        if (FindPhone.active === this) FindPhone.active = null
        super.onDestroy()
    }
}
