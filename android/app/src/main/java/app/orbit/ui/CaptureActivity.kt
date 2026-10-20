package app.orbit.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors

/**
 * Uygulama içi kamera: görev kanıtı için foto veya kısa video çeker.
 * Galeriye erişim yok; her kanıt o an çekilir. Fotoğraf küçültülür, video en fazla 30 saniye ve düşük çözünürlüklüdür.
 *
 * Girdi: "media" = photo | video | either, "title" = ekranda gösterilecek başlık
 * Çıktı: "path" = dosya yolu, "media" = photo | video
 */
class CaptureActivity : ComponentActivity() {
    companion object {
        private const val TAG = "OrbitCapture"
        const val MAX_VIDEO_SECONDS = 30
    }

    private var imageCapture: ImageCapture? = null
    private var videoCapture: VideoCapture<Recorder>? = null
    private var recording: Recording? = null
    private val exec = Executors.newSingleThreadExecutor()

    private var busy by mutableStateOf(false)
    private var recordingSecs by mutableIntStateOf(-1)
    private var error by mutableStateOf("")
    private var useFront by mutableStateOf(false)
    private var previewView: PreviewView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val media = intent.getStringExtra("media") ?: "photo"
        val title = intent.getStringExtra("title") ?: "Kanıt"
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO), 1)
        }
        setContent {
            OrbitTheme {
                Column(Modifier.fillMaxSize().background(Color.Black).safeDrawingPadding()) {
                    Text(title, color = C.text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(16.dp))
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        AndroidView(factory = { ctx ->
                            PreviewView(ctx).also { previewView = it; bind() }
                        }, modifier = Modifier.fillMaxSize())
                        if (recordingSecs >= 0) {
                            Text(
                                "● ${recordingSecs}s / ${MAX_VIDEO_SECONDS}s", color = C.bad, fontWeight = FontWeight.Bold,
                                modifier = Modifier.align(Alignment.TopCenter).padding(12.dp),
                            )
                        }
                    }
                    if (error.isNotEmpty()) Text(error, color = C.bad, modifier = Modifier.padding(12.dp))
                    Controls(media)
                }
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        bind()
    }

    @Composable
    private fun Controls(media: String) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                if (media != "video" && recordingSecs < 0) {
                    Button(
                        onClick = { takePhoto() }, enabled = !busy,
                        modifier = Modifier.weight(1f).height(56.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = C.accent),
                    ) { Text("Fotoğraf çek") }
                }
                if (media != "photo") {
                    Button(
                        onClick = { if (recordingSecs >= 0) stopVideo() else startVideo() }, enabled = !busy || recordingSecs >= 0,
                        modifier = Modifier.weight(1f).height(56.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = if (recordingSecs >= 0) C.bad else C.blue),
                    ) { Text(if (recordingSecs >= 0) "Durdur" else "Video çek") }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                OutlinedButton(onClick = { useFront = !useFront; bind() }, enabled = recordingSecs < 0, modifier = Modifier.weight(1f)) {
                    Text("Kamerayı çevir")
                }
                OutlinedButton(onClick = { setResult(Activity.RESULT_CANCELED); finish() }, enabled = recordingSecs < 0, modifier = Modifier.weight(1f)) {
                    Text("Vazgeç")
                }
            }
        }
    }

    private fun bind() {
        val pv = previewView ?: return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            error = "Kamera izni yok"
            return
        }
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            runCatching {
                val provider = future.get()
                val preview = Preview.Builder().build().also { it.surfaceProvider = pv.surfaceProvider }
                val ic = ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build()
                val recorder = Recorder.Builder()
                    .setQualitySelector(QualitySelector.from(Quality.SD, FallbackStrategy.lowerQualityOrHigherThan(Quality.SD)))
                    .build()
                val vc = VideoCapture.withOutput(recorder)
                val selector = if (useFront) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
                provider.unbindAll()
                provider.bindToLifecycle(this, selector, preview, ic, vc)
                imageCapture = ic
                videoCapture = vc
                error = ""
            }.onFailure {
                Log.e(TAG, "kamera", it)
                error = "Kamera açılamadı"
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun takePhoto() {
        val ic = imageCapture ?: return
        busy = true
        ic.takePicture(exec, object : ImageCapture.OnImageCapturedCallback() {
            override fun onCaptureSuccess(image: ImageProxy) {
                val out = File(cacheDir, "proof-${System.currentTimeMillis()}.jpg")
                runCatching {
                    val rot = image.imageInfo.rotationDegrees
                    var bmp = image.toBitmap()
                    image.close()
                    if (rot != 0) bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(rot.toFloat()) }, true)
                    val max = 1600f
                    val scale = minOf(1f, max / maxOf(bmp.width, bmp.height))
                    if (scale < 1f) bmp = Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true)
                    FileOutputStream(out).use { bmp.compress(Bitmap.CompressFormat.JPEG, 80, it) }
                }.onFailure { Log.e(TAG, "foto", it) }
                runOnUiThread {
                    busy = false
                    if (out.exists() && out.length() > 0) done(out, "photo") else error = "Fotoğraf kaydedilemedi"
                }
            }

            override fun onError(e: ImageCaptureException) {
                Log.e(TAG, "foto", e)
                runOnUiThread { busy = false; error = "Fotoğraf çekilemedi" }
            }
        })
    }

    @SuppressLint("MissingPermission")
    private fun startVideo() {
        val vc = videoCapture ?: return
        val out = File(cacheDir, "proof-${System.currentTimeMillis()}.mp4")
        busy = true
        var pending = vc.output.prepareRecording(this, FileOutputOptions.Builder(out).setDurationLimitMillis(MAX_VIDEO_SECONDS * 1000L).build())
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            pending = pending.withAudioEnabled()
        }
        recording = pending.start(ContextCompat.getMainExecutor(this)) { ev ->
            when (ev) {
                is VideoRecordEvent.Start -> recordingSecs = 0
                is VideoRecordEvent.Status -> recordingSecs = (ev.recordingStats.recordedDurationNanos / 1_000_000_000L).toInt()
                is VideoRecordEvent.Finalize -> {
                    recordingSecs = -1
                    busy = false
                    recording = null
                    val ok = !ev.hasError() || ev.error == VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED
                    if (ok && out.exists() && out.length() > 0) done(out, "video") else error = "Video kaydedilemedi"
                }
            }
        }
    }

    private fun stopVideo() {
        recording?.stop()
    }

    private fun done(file: File, media: String) {
        setResult(Activity.RESULT_OK, Intent().putExtra("path", file.absolutePath).putExtra("media", media))
        finish()
    }

    override fun onDestroy() {
        recording?.stop()
        exec.shutdown()
        super.onDestroy()
    }
}
