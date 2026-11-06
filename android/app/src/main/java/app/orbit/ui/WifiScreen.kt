package app.orbit.ui

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import app.orbit.data.Wifi
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.Executors

private fun bars(level: Int) = listOf("▂", "▂▄", "▂▄▆", "▂▄▆█", "▂▄▆█")[level.coerceIn(0, 4)]
private fun secLabel(s: String) = when (s) { "open" -> "şifresiz"; "wpa3" -> "WPA3"; "wep" -> "WEP"; "eap" -> "kurumsal"; else -> "WPA2" }

/** Bağlanma isteği (şifre penceresi) */
private data class Ask(val ssid: String, val security: String, val hidden: Boolean = false, val manual: Boolean = false)

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun WifiScreen() {
    val scope = rememberCoroutineScope()
    val st by Wifi.status.collectAsState()
    val saved by Wifi.saved.collectAsState()
    val nearby by Wifi.nearby.collectAsState()
    val settings by Wifi.settings.collectAsState()
    val scanning by Wifi.scanning.collectAsState()
    var ask by remember { mutableStateOf<Ask?>(null) }
    var qr by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    var forget by remember { mutableStateOf<Wifi.Saved?>(null) }
    var scanned by remember { mutableStateOf<Wifi.QrNet?>(null) }

    LaunchedEffect(Unit) {
        Wifi.scan()
        withContext(Dispatchers.IO) { runCatching { Wifi.syncVault() } }
    }

    fun run(label: String, block: suspend () -> Result<Unit>) {
        msg = "$label…" to true
        scope.launch {
            val r = block()
            msg = r.fold({ "Bağlandı ✓" to true }, { (it.message ?: "Bağlanamadı") to false })
        }
    }

    // --- bağlı ağ ---
    Card {
        when {
            st.connecting != null -> { Title("Bağlanıyor: ${st.connecting}"); Muted("Birkaç saniye sürebilir…") }
            st.connected && st.captive -> {
                Title("⚠ Bağlı: ${st.ssid ?: "Wi-Fi"}")
                Text("Onay bekleniyor", color = C.warn, fontSize = 14.sp)
                Button(onClick = { Wifi.openPortal() }, colors = ButtonDefaults.buttonColors(containerColor = C.accent), modifier = Modifier.fillMaxWidth()) {
                    Text("🌐 Onay sayfasını aç")
                }
            }
            st.connected -> {
                Title("✓ Bağlı: ${st.ssid ?: "Wi-Fi"}")
                Muted(if (st.validated) "İnternet var" else "İnternet kontrol ediliyor…")
            }
            else -> { Title("Wi-Fi'ye bağlı değil"); Muted(if (st.online) "Mobil veri kullanılıyor" else "İnternet yok") }
        }
    }
    msg?.let { (t, ok) -> Text(t, color = if (ok) C.good else C.bad, fontSize = 14.sp) }

    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
        Button(onClick = { qr = true }, colors = ButtonDefaults.buttonColors(containerColor = C.accent), modifier = Modifier.weight(1f)) { Text("📷 QR ile bağlan") }
        OutlinedButton(onClick = { ask = Ask("", "wpa", manual = true) }, modifier = Modifier.weight(1f)) { Text("＋ Elle ekle") }
    }
    if (!settings.childAdd) Muted("Yeni ağ eklemek kapalı; kayıtlı ağlara bağlanabilirsin.", 13)

    if (qr) QrScanner(
        onCancel = { qr = false },
        onCode = { text ->
            val n = Wifi.parseQr(text)
            if (n == null) { msg = "Bu bir Wi-Fi QR kodu değil" to false; false } else {
                qr = false
                scanned = n
                true
            }
        },
    )

    // --- kayıtlı ağlar ---
    if (saved.isNotEmpty()) {
        Text("KAYITLI AĞLAR", color = C.muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Card {
            for (s in saved) {
                val here = nearby.firstOrNull { it.ssid == s.ssid }
                val on = st.connected && st.ssid == s.ssid
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                        .combinedClickable(onClick = { if (!on) run(s.ssid) { Wifi.connectSaved(s) } }, onLongClick = { forget = s })
                        .padding(vertical = 10.dp, horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(s.ssid, color = C.text, fontSize = 16.sp)
                        if (s.password.isEmpty() && s.security != "open") Text("şifre eksik", color = C.warn, fontSize = 12.sp)
                    }
                    Text(
                        when { on && st.captive -> "onay bekliyor"; on -> "bağlı"; here != null -> bars(here.level); else -> "yakında değil" },
                        color = if (on) C.good else C.muted, fontSize = 13.sp,
                    )
                }
            }
            Muted("Basılı tut: unut", 12)
        }
    }

    // --- yakındaki ağlar ---
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Text("YAKINDAKİ AĞLAR", color = C.muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        TextButton(onClick = { scope.launch { Wifi.scan() } }, enabled = !scanning) { Text(if (scanning) "Taranıyor…" else "⟳ Tara") }
    }
    val others = nearby.filter { n -> saved.none { it.ssid == n.ssid } }
    Card {
        if (others.isEmpty()) Muted(if (scanning) "Taranıyor…" else "Yakında başka ağ bulunamadı.")
        for (n in others) {
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable {
                    when {
                        n.security == "eap" -> msg = "Kurumsal ağlar desteklenmiyor" to false
                        !settings.childAdd -> msg = "Yeni ağ eklemek kapalı (ebeveyn ayarı)" to false
                        n.security == "open" -> run(n.ssid) { Wifi.connect(n.ssid, "", "open", false, "scan") }
                        else -> ask = Ask(n.ssid, n.security)
                    }
                }.padding(vertical = 10.dp, horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(if (n.security == "open") "  " else "🔒", fontSize = 14.sp)
                Column(Modifier.weight(1f).padding(start = 8.dp)) {
                    Text(n.ssid, color = C.text, fontSize = 16.sp)
                    if (n.security == "open") Muted("şifresiz · onay sayfası çıkabilir", 12)
                }
                Text(bars(n.level), color = C.muted, fontSize = 13.sp)
            }
        }
    }

    // --- şifre / elle ekleme penceresi ---
    ask?.let { a ->
        var ssid by remember(a) { mutableStateOf(a.ssid) }
        var pass by remember(a) { mutableStateOf("") }
        var sec by remember(a) { mutableStateOf(a.security) }
        var hidden by remember(a) { mutableStateOf(a.hidden) }
        var show by remember(a) { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { ask = null },
            title = { Text(if (a.manual) "Ağ ekle" else a.ssid) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (a.manual) OutlinedTextField(ssid, { ssid = it }, label = { Text("Ağ adı") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    if (a.manual) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (o in listOf("wpa", "wpa3", "open")) {
                            val on = sec == o
                            Box(
                                Modifier.clip(RoundedCornerShape(10.dp)).background(if (on) C.accent else C.surface2).clickable { sec = o }.padding(horizontal = 10.dp, vertical = 6.dp),
                            ) { Text(secLabel(o), color = C.text, fontSize = 13.sp) }
                        }
                    }
                    if (sec != "open") OutlinedTextField(
                        pass, { pass = it }, label = { Text("Şifre") }, singleLine = true,
                        visualTransformation = if (show) VisualTransformation.None else PasswordVisualTransformation(),
                        trailingIcon = { TextButton(onClick = { show = !show }) { Text(if (show) "Gizle" else "Göster") } },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (a.manual) Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(hidden, { hidden = it })
                        Text("Gizli ağ (listede görünmüyor)", color = C.text, fontSize = 14.sp)
                    }
                }
            },
            dismissButton = { TextButton(onClick = { ask = null }) { Text("Vazgeç") } },
            confirmButton = {
                TextButton(onClick = {
                    val name = ssid.trim()
                    if (name.isEmpty()) return@TextButton
                    ask = null
                    run(name) { Wifi.connect(name, pass, sec, hidden, if (a.manual) "manual" else "scan") }
                }) { Text("Bağlan") }
            },
        )
    }

    // QR okundu: şimdi bağlan ya da sadece kaydet
    scanned?.let { n ->
        val known = saved.any { it.ssid == n.ssid }
        AlertDialog(
            onDismissRequest = { scanned = null },
            title = { Text("📶 ${n.ssid}") },
            text = { Text(if (known) "Bu ağ zaten kayıtlı; şifresi güncellenecek." else "Şimdi bağlanabilir ya da sadece kaydedebilirsin. Kaydedilen ağa telefon yakınına gelince kendiliğinden bağlanır.") },
            dismissButton = {
                TextButton(onClick = {
                    scanned = null
                    msg = "Kaydediliyor…" to true
                    scope.launch { msg = Wifi.saveOnly(n.ssid, n.password, n.security, n.hidden, "qr").fold({ "Kaydedildi ✓" to true }, { (it.message ?: "Kaydedilemedi") to false }) }
                }) { Text("Sadece kaydet") }
            },
            confirmButton = {
                TextButton(onClick = { scanned = null; run(n.ssid) { Wifi.connect(n.ssid, n.password, n.security, n.hidden, "qr") } }) { Text("Bağlan") }
            },
        )
    }

    forget?.let { s ->
        AlertDialog(
            onDismissRequest = { forget = null },
            title = { Text("${s.ssid} unutulsun mu?") },
            text = { Text("Telefon bu ağa artık kendiliğinden bağlanmaz. Kasadaki kaydı da silinir.") },
            dismissButton = { TextButton(onClick = { forget = null }) { Text("Vazgeç") } },
            confirmButton = { TextButton(onClick = { forget = null; scope.launch { Wifi.forget(s) } }) { Text("Unut", color = C.bad) } },
        )
    }
}

/** Kamera ile Wi-Fi QR kodu okur. onCode true dönerse tarama biter. */
@Composable
fun QrScanner(onCancel: () -> Unit, onCode: (String) -> Boolean) {
    val ctx = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val exec = remember { Executors.newSingleThreadExecutor() }
    val reader = remember {
        MultiFormatReader().apply { setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true)) }
    }
    var provider by remember { mutableStateOf<ProcessCameraProvider?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    DisposableEffect(Unit) {
        onDispose { runCatching { provider?.unbindAll() }; exec.shutdown() }
    }
    // Ekranın ortasında, uygulamanın üstünde açılan pencere
    androidx.compose.ui.window.Dialog(
        onDismissRequest = onCancel,
        properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
    ) {
    Box(Modifier.fillMaxWidth().padding(horizontal = 20.dp).clip(RoundedCornerShape(20.dp)).background(C.surface).padding(16.dp)) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Title("📷 QR kodu kameraya göster")
        Muted("Router'ın üstündeki ya da iPhone'da \"Wi-Fi'yi paylaş\" ile çıkan kod.", 13)
        err?.let { Text(it, color = C.bad, fontSize = 13.sp) }
        AndroidView(
            factory = { c ->
                PreviewView(c).also { pv ->
                    pv.implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                    val f = ProcessCameraProvider.getInstance(c)
                    f.addListener({
                        val p = runCatching { f.get() }.getOrNull() ?: return@addListener
                        provider = p
                        val preview = Preview.Builder().build().also { it.setSurfaceProvider(pv.surfaceProvider) }
                        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                        var done = false
                        analysis.setAnalyzer(exec) { img ->
                            try {
                                if (done) return@setAnalyzer
                                val plane = img.planes[0]
                                val buf = plane.buffer
                                val bytes = ByteArray(plane.rowStride * img.height)
                                buf.rewind(); buf.get(bytes, 0, minOf(buf.remaining(), bytes.size))
                                val src = PlanarYUVLuminanceSource(bytes, plane.rowStride, img.height, 0, 0, img.width, img.height, false)
                                val text = runCatching { reader.decodeWithState(BinaryBitmap(HybridBinarizer(src))).text }.getOrNull()
                                reader.reset()
                                if (text != null) ContextCompat.getMainExecutor(c).execute { if (!done && onCode(text)) done = true }
                            } finally { img.close() }
                        }
                        runCatching { p.unbindAll(); p.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis) }
                            .onFailure { err = "Kamera açılamadı (başka bir kayıt sürüyor olabilir)" }
                    }, ContextCompat.getMainExecutor(c))
                }
            },
            modifier = Modifier.fillMaxWidth().height(320.dp).clip(RoundedCornerShape(12.dp)),
        )
        OutlinedButton(onClick = onCancel, modifier = Modifier.fillMaxWidth()) { Text("Vazgeç") }
    }
    }
    }
}

/** Bugün ekranının üstündeki şerit: internet yok ya da Wi-Fi onay bekliyor */
@Composable
fun WifiBanner(open: () -> Unit) {
    val st by Wifi.status.collectAsState()
    val text = when {
        st.connected && st.captive -> "⚠ ${st.ssid ?: "Wi-Fi"} onay bekliyor · Aç"
        !st.online -> "📶 İnternet yok · Wi-Fi'ye bağlan"
        else -> return
    }
    Box(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.warn.copy(alpha = 0.18f))
            .clickable { if (st.connected && st.captive) Wifi.openPortal() else open() }.padding(12.dp),
    ) { Text(text, color = C.warn, fontSize = 15.sp, fontWeight = FontWeight.SemiBold) }
}
