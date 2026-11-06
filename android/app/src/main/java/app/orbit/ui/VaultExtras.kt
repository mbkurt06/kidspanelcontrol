package app.orbit.ui

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.Sync
import app.orbit.device.Policy
import app.orbit.service.Live
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import org.json.JSONObject

/** QR kod resmi (siyah-beyaz, kenarlı) */
fun qrBitmap(text: String, size: Int = 720): Bitmap {
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 2, EncodeHintType.CHARACTER_SET to "UTF-8"))
    val px = IntArray(m.width * m.height) { i -> if (m.get(i % m.width, i / m.width)) android.graphics.Color.BLACK else android.graphics.Color.WHITE }
    return Bitmap.createBitmap(px, m.width, m.height, Bitmap.Config.ARGB_8888)
}

/** Wi-Fi paylaşma: başkası telefon kamerasıyla okutup bağlanır */
@Composable
fun WifiQrDialog(ssid: String, password: String, qr: String, onClose: () -> Unit) {
    val bmp = remember(qr) { qrBitmap(qr) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("📶 $ssid") },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                Box(Modifier.clip(RoundedCornerShape(12.dp)).background(Color.White).padding(8.dp)) {
                    Image(bmp.asImageBitmap(), null, filterQuality = FilterQuality.None, modifier = Modifier.size(240.dp))
                }
                Text("Kamerayla okutunca bağlanır", color = C.muted, fontSize = 13.sp, textAlign = TextAlign.Center)
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Kapat") } },
    )
}

/** Telefondaki uygulamalardan seç */
@Composable
fun AppPickerDialog(onPick: (pkg: String, label: String) -> Unit, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val apps = remember { Policy.launchables(ctx).sortedBy { it.label.lowercase() } }
    var q by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Uygulama seç") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(q, { q = it }, label = { Text("Ara") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                    for (a in apps.filter { q.isBlank() || it.label.contains(q, true) }) {
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { onPick(a.pkg, a.label) }.padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            AppIcon(a.pkg, 32.dp)
                            Spacer(Modifier.width(10.dp))
                            Text(a.label, color = C.text)
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Vazgeç") } },
    )
}

fun appLabel(ctx: Context, pkg: String): String =
    runCatching { ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo(pkg, 0)).toString() }.getOrDefault(pkg)

/** Uygulama şu an kurallara göre açılabilir mi */
fun appOpenNow(pkg: String): Boolean {
    val live = Live.state.value
    if (live.snapshot?.parentMode == true || live.pinUntil != null) return true
    if (live.kiosk != null) return false
    return live.allowedApps.any { it.first == pkg }
}

/** Kapalı uygulama/site için: "Şu an kapalı" + ebeveynden iste */
data class Blocked(val pkg: String?, val label: String)

sealed class OpenResult {
    data object Opened : OpenResult()
    data class Closed(val b: Blocked) : OpenResult()
    data object Missing : OpenResult()
}

fun openApp(ctx: Context, pkg: String): OpenResult {
    if (ctx.packageManager.getLaunchIntentForPackage(pkg) == null) return OpenResult.Missing
    if (!appOpenNow(pkg)) return OpenResult.Closed(Blocked(pkg, appLabel(ctx, pkg)))
    return if (launch(ctx, pkg)) OpenResult.Opened else OpenResult.Missing
}

/** Web sitesini izinli bir tarayıcıda aç */
fun openUrl(ctx: Context, url: String): OpenResult {
    val u = Uri.parse(if (url.startsWith("http://") || url.startsWith("https://")) url else "https://${url.trim()}")
    val view = Intent(Intent.ACTION_VIEW, u)
    val browsers = ctx.packageManager.queryIntentActivities(view, 0).map { it.activityInfo.packageName }.distinct()
    if (browsers.isEmpty()) return OpenResult.Missing
    val ok = browsers.firstOrNull { appOpenNow(it) } ?: return OpenResult.Closed(Blocked(browsers.first(), "Tarayıcı (${appLabel(ctx, browsers.first())})"))
    return if (runCatching { ctx.startActivity(view.setPackage(ok).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true }.getOrDefault(false)) OpenResult.Opened else OpenResult.Missing
}

@Composable
fun BlockedDialog(b: Blocked, onClose: () -> Unit) {
    var sent by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Şu an kapalı") },
        text = { Text(sent ?: "${b.label} şu an kurallara göre açılamıyor. İstersen ebeveyninden izin iste.") },
        dismissButton = { TextButton(onClick = onClose) { Text("Kapat") } },
        confirmButton = {
            if (sent == null && b.pkg != null) TextButton(onClick = {
                sent = "Gönderiliyor…"
                Thread {
                    val ok = Sync.event("app_request", JSONObject().put("package", b.pkg).put("label", b.label).put("note", "Şifrelerim'den açmak istiyor"))
                    sent = if (ok) "İstek gönderildi ✓" else "İnternet gerekli"
                }.start()
            }) { Text("Ebeveynden iste") }
        },
    )
}
