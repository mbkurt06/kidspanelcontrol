package app.orbit.ui

import android.app.NotificationManager
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
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
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.Alarms
import app.orbit.data.Store
import java.time.LocalTime
import kotlin.concurrent.thread

/** Tam ekran alarm: sesli çalar, "Kapat" ya da (izin varsa) "Ertele". Telefon kilitliyken de açılır. */
class AlarmActivity : ComponentActivity() {
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Store.init(this)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val id = intent.getStringExtra("id") ?: run { finish(); return }
        val title = intent.getStringExtra("title") ?: "Alarm"
        val kind = intent.getStringExtra("kind") ?: "alarm"
        val snoozeMax = intent.getIntExtra("snoozeMax", 3)
        val snoozeMinutes = intent.getIntExtra("snoozeMinutes", 5)
        val snoozes = intent.getIntExtra("snoozes", 0)
        val noteId = intent.getIntExtra("noteId", 0)

        startSound()

        fun close() {
            stopSound()
            getSystemService(NotificationManager::class.java).cancel(noteId)
            finish()
        }

        setContent {
            OrbitTheme {
                Column(
                    Modifier.fillMaxSize().background(C.bg).safeDrawingPadding().padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("⏰", fontSize = 72.sp)
                    Text(LocalTime.now().toString().take(5), color = C.text, fontSize = 56.sp, fontWeight = FontWeight.Bold)
                    Text(title, color = C.text, fontSize = 26.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
                    if (snoozes > 0) Muted("$snoozes kez ertelendi", 14)
                    Button(
                        onClick = {
                            val logId = Store.prefs().getString("alarmLog:$id", null)
                            thread { Alarms.logDismiss(logId, snoozes) }
                            close()
                        },
                        modifier = Modifier.fillMaxWidth().height(64.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = C.accent),
                    ) { Text("Kapat", fontSize = 20.sp) }
                    if (snoozes < snoozeMax) {
                        OutlinedButton(
                            onClick = {
                                Alarms.snooze(this@AlarmActivity, id, title, kind, snoozeMax, snoozeMinutes, snoozes + 1)
                                close()
                            },
                            modifier = Modifier.fillMaxWidth().height(56.dp),
                        ) { Text("$snoozeMinutes dk ertele (${snoozeMax - snoozes} hak)", fontSize = 16.sp) }
                    }
                }
            }
        }
    }

    private fun startSound() {
        runCatching {
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            player = MediaPlayer().apply {
                setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                setDataSource(this@AlarmActivity, uri)
                isLooping = true
                prepare()
                start()
            }
        }
        runCatching {
            @Suppress("DEPRECATION")
            vibrator = getSystemService(Vibrator::class.java)
            vibrator?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 800, 600), 0))
        }
    }

    private fun stopSound() {
        runCatching { player?.stop(); player?.release() }
        player = null
        runCatching { vibrator?.cancel() }
    }

    override fun onDestroy() {
        stopSound()
        super.onDestroy()
    }
}
