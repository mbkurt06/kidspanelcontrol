package app.orbit.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.remember
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
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
import androidx.compose.runtime.mutableStateListOf
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
    private val photos = mutableStateListOf<String>()
    private var minPhotos = 1
    private var maxPhotos = 1
    private var multiPhoto = false
    /** Çekilen kare/video onay bekliyor: "Yeniden çek" / "Kullan" */
    private var review by mutableStateOf<Pair<String, String>?>(null)
    private var reviewBmp by mutableStateOf<Bitmap?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val media = intent.getStringExtra("media") ?: "photo"
        val title = intent.getStringExtra("title") ?: "Kanıt"
        minPhotos = intent.getIntExtra("minPhotos", 1).coerceIn(1, 4)
        maxPhotos = intent.getIntExtra("maxPhotos", 1).coerceIn(minPhotos, 4)
        multiPhoto = media != "video" && maxPhotos > 1
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
                        if (multiPhoto && photos.isNotEmpty()) {
                            Text("Fotoğraf ${photos.size}/$maxPhotos", color = C.text, fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.TopEnd).padding(12.dp))
                        }
                        review?.let { (path, kind) ->
                            Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
                                val b = reviewBmp
                                if (kind == "photo" && b != null) Image(b.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                                else Text(if (kind == "video") "🎬 Video hazır" else "Önizleme", color = C.text, fontSize = 20.sp)
                            }
                        }
                    }
                    if (multiPhoto && photos.isNotEmpty() && review == null) {
                        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            photos.toList().forEach { p ->
                                val th = remember(p) { runCatching { BitmapFactory.decodeFile(p, BitmapFactory.Options().apply { inSampleSize = 8 }) }.getOrNull() }
                                Box(Modifier.size(64.dp).clip(RoundedCornerShape(10.dp)).background(C.surface2)) {
                                    th?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
                                    Box(
                                        Modifier.align(Alignment.TopEnd).padding(2.dp).size(22.dp).clip(CircleShape).background(Color(0xCC000000))
                                            .clickable { photos.remove(p); File(p).delete() },
                                        contentAlignment = Alignment.Center,
                                    ) { Text("×", color = Color.White, fontSize = 14.sp) }
                                }
                            }
                        }
                    }
                    if (error.isNotEmpty()) Text(error, color = C.bad, modifier = Modifier.padding(12.dp))
                    if (review != null) ReviewControls() else Controls(media)
                }
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        bind()
    }

    @Composable
    private fun ReviewControls() {
        Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(onClick = { retake() }, modifier = Modifier.weight(1f).height(56.dp)) { Text("↺ Yeniden çek") }
            Button(
                onClick = { accept() },
                modifier = Modifier.weight(1f).height(56.dp),
                colors = ButtonDefaults.buttonColors(containerColor = C.accent),
            ) { Text("✓ Kullan") }
        }
    }

    private fun retake() {
        review?.let { File(it.first).delete() }
        review = null
        reviewBmp = null
    }

    private fun accept() {
        val (path, kind) = review ?: return
        review = null
        reviewBmp = null
        if (kind == "video") { done(listOf(path), "video"); return }
        if (multiPhoto) {
            photos += path
            if (photos.size >= maxPhotos) finishPhotos()
        } else done(listOf(path), "photo")
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
                    ) { Text(if (multiPhoto) "Fotoğraf çek" else "Fotoğraf çek") }
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
                if (multiPhoto) {
                    OutlinedButton(onClick = { finishPhotos() }, enabled = recordingSecs < 0 && photos.size >= minPhotos && !busy, modifier = Modifier.weight(1f)) {
                        Text("Bitti")
                    }
                }
                OutlinedButton(onClick = { cancelCapture(); }, enabled = recordingSecs < 0 && !busy, modifier = Modifier.weight(1f)) {
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
                    if (out.exists() && out.length() > 0) {
                        reviewBmp = runCatching { BitmapFactory.decodeFile(out.absolutePath) }.getOrNull()
                        review = out.absolutePath to "photo"
                    } else error = "Fotoğraf kaydedilemedi"
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
                    if (ok && out.exists() && out.length() > 0) review = out.absolutePath to "video" else error = "Video kaydedilemedi"
                }
            }
        }
    }

    private fun stopVideo() {
        recording?.stop()
    }

    private fun done(paths: List<String>, media: String) {
        photos.clear()
        setResult(Activity.RESULT_OK, Intent().putStringArrayListExtra("paths", ArrayList(paths)).putExtra("path", paths.firstOrNull()).putExtra("media", media))
        finish()
    }

    private fun finishPhotos() {
        if (photos.size < minPhotos) return
        done(photos.toList(), "photo")
    }

    private fun cancelCapture() {
        photos.forEach { File(it).delete() }
        setResult(Activity.RESULT_CANCELED)
        finish()
    }

    override fun onDestroy() {
        recording?.stop()
        if (isFinishing && !isChangingConfigurations && photos.isNotEmpty()) photos.forEach { File(it).delete() }
        if (isFinishing) review?.let { File(it.first).delete() }
        exec.shutdown()
        super.onDestroy()
    }
}
