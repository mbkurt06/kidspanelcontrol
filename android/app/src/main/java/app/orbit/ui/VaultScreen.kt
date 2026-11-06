package app.orbit.ui

import android.app.Activity
import android.app.KeyguardManager
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.os.Build
import android.os.PersistableBundle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.Vault
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Şifrelerim: ana ekranın içinde (menü kaybolmadan) açılır.
 * Açılırken telefonun kilidi (PIN/parmak izi) istenir; vazgeçilirse onCancel ile geri dönülür.
 * Kopyalanan bilgi 30 sn sonra panodan silinir.
 */
@Composable
fun VaultScreen(onCancel: () -> Unit, onWifi: () -> Unit = {}) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var unlocked by remember { mutableStateOf(false) }
    var state by remember { mutableStateOf<Vault.State?>(null) }
    var entries by remember { mutableStateOf<List<Vault.Entry>>(emptyList()) }
    var editing by remember { mutableStateOf<Vault.Entry?>(null) }
    var msg by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var clearAt by remember { mutableStateOf(0L) }
    var deleteEntry by remember { mutableStateOf<Vault.Entry?>(null) }
    var deleteArmed by remember { mutableStateOf<String?>(null) }
    val revealed = remember { mutableStateMapOf<String, Boolean>() }
    var qrFor by remember { mutableStateOf<Vault.Entry?>(null) }
    var scanFor by remember { mutableStateOf<String?>(null) } // "" = yeni ağ, yoksa o ağın adı
    var pwFor by remember { mutableStateOf<Vault.Entry?>(null) }
    var picking by remember { mutableStateOf(false) }
    var blocked by remember { mutableStateOf<Blocked?>(null) }
    fun opened(r: OpenResult) { when (r) { is OpenResult.Closed -> blocked = r.b; OpenResult.Missing -> msg = "Açılamadı (telefonda yok)"; else -> {} } }

    fun load() {
        busy = true
        scope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    val s = Vault.open()
                    s to (if (s is Vault.State.Open) Vault.list(s.key) else emptyList())
                }
            }
            r.onSuccess { (s, list) -> state = s; entries = list }.onFailure { msg = "İnternet gerekli: ${it.message ?: ""}" }
            busy = false
        }
    }

    val auth = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        if (r.resultCode == Activity.RESULT_OK) { unlocked = true; load() } else onCancel()
    }

    LaunchedEffect(Unit) {
        val km = ctx.getSystemService(KeyguardManager::class.java)
        @Suppress("DEPRECATION")
        val i = if (km.isDeviceSecure) km.createConfirmDeviceCredentialIntent("Şifrelerim", "Kasayı açmak için telefon kilidini gir") else null
        if (i != null) auth.launch(i) else { unlocked = true; load() }
    }

    // Kopyalanan bilgiyi 30 sn sonra panodan sil (ekrandan çıkılsa da)
    LaunchedEffect(clearAt) {
        if (clearAt == 0L) return@LaunchedEffect
        delay(30_000)
        runCatching { ctx.getSystemService(ClipboardManager::class.java).clearPrimaryClip() }
        msg = ""
    }
    DisposableEffect(Unit) {
        onDispose { if (clearAt != 0L) runCatching { ctx.getSystemService(ClipboardManager::class.java).clearPrimaryClip() } }
    }

    fun copy(label: String, text: String) {
        val cm = ctx.getSystemService(ClipboardManager::class.java)
        val clip = ClipData.newPlainText(label, text)
        if (Build.VERSION.SDK_INT >= 33) {
            clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
        }
        cm.setPrimaryClip(clip)
        msg = "$label kopyalandı (30 sn sonra silinir)"
        clearAt = System.currentTimeMillis()
    }

    fun save(e: Vault.Entry) {
        val s = state as? Vault.State.Open ?: return
        busy = true
        scope.launch {
            val prev = entries.firstOrNull { it.id == e.id && e.id != null }
            val r = withContext(Dispatchers.IO) { runCatching { Vault.save(s.key, e, prev) } }
            if (r.isSuccess) { editing = null; load() } else { msg = "Kaydedilemedi"; busy = false }
        }
    }

    if (!unlocked) {
        Muted("Telefon kilidi bekleniyor…")
        return
    }
    deleteEntry?.let { pending ->
        AlertDialog(
            onDismissRequest = { deleteEntry = null },
            title = { Text("Şifreyi sil?") },
            text = { Text("${pending.app} kaydı kalıcı olarak kaldırılacak.") },
            dismissButton = { TextButton(onClick = { deleteEntry = null }) { Text("İptal") } },
            confirmButton = { TextButton(onClick = {
                deleteEntry = null
                scope.launch { withContext(Dispatchers.IO) { runCatching { Vault.remove(pending.id!!) } }; load() }
            }) { Text("Sil", color = C.bad) } },
        )
    }
    qrFor?.let { w -> WifiQrDialog(w.app, w.password, app.orbit.data.Wifi.qrText(w.app, w.password, w.security, w.hidden)) { qrFor = null } }
    blocked?.let { b -> BlockedDialog(b) { blocked = null } }
    pwFor?.let { w ->
        var pw by remember(w) { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { pwFor = null },
            title = { Text("${w.app} şifresi") },
            text = { OutlinedTextField(pw, { pw = it }, label = { Text("Şifre") }, singleLine = true, modifier = Modifier.fillMaxWidth()) },
            dismissButton = { TextButton(onClick = { pwFor = null }) { Text("Vazgeç") } },
            confirmButton = {
                TextButton(onClick = {
                    pwFor = null
                    busy = true
                    scope.launch {
                        val r = app.orbit.data.Wifi.saveOnly(w.app, pw, w.security.ifBlank { "wpa" }, w.hidden, "manual")
                        msg = r.fold({ "Kaydedildi ✓" }, { it.message ?: "Kaydedilemedi" })
                        load()
                    }
                }) { Text("Kaydet") }
            },
        )
    }
    if (picking) AppPickerDialog(onPick = { pkg, label ->
        picking = false
        editing = editing?.let { it.copy(pkg = pkg, app = it.app.ifBlank { label }) }
    }, onClose = { picking = false })
    if (msg.isNotEmpty()) Text(msg, color = C.good, fontSize = 13.sp)
    when (val s = state) {
        null -> Muted(if (busy) "Açılıyor…" else "")
        Vault.State.None -> Card {
            Title("Kasa henüz yok")
            Row(verticalAlignment = Alignment.CenterVertically) { Info("Uygulama hesaplarının kullanıcı adı ve şifrelerini burada saklayabilirsin. Sadece sen ve ebeveynlerin görebilir.") }
            Button(onClick = {
                busy = true
                scope.launch {
                    val r = withContext(Dispatchers.IO) { runCatching { Vault.create() } }
                    if (r.isSuccess) load() else { msg = "Oluşturulamadı"; busy = false }
                }
            }, enabled = !busy, colors = ButtonDefaults.buttonColors(containerColor = C.accent)) { Text("Kasayı oluştur") }
        }
        Vault.State.Locked -> Card {
            Title("Kasa anahtarı bekleniyor")
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Info("Ebeveynin panelde \"Şifreler\" sayfasını açınca kasa bu telefona da açılır.")
                    }
            OutlinedButton(onClick = { load() }) { Text("Tekrar dene") }
        }
        is Vault.State.Open -> {
            val e = editing
            if (e != null) {
                fun upd(f: (Vault.Entry) -> Vault.Entry) { editing = editing?.let(f) }
                Card {
                    Title(if (e.id == null) "Yeni hesap" else "Düzenle")
                    OutlinedTextField(e.app, { v -> upd { it.copy(app = v) } }, label = { Text("Uygulama / site") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(e.username, { v -> upd { it.copy(username = v) } }, label = { Text("Kullanıcı adı / e-posta") }, modifier = Modifier.fillMaxWidth())
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(e.password, { v -> upd { it.copy(password = v) } }, label = { Text("Şifre") }, modifier = Modifier.weight(1f))
                        TextButton(onClick = { val p = Vault.generatePassword(); upd { it.copy(password = p) } }) { Text("Üret") }
                    }
                    OutlinedTextField(e.url, { v -> upd { it.copy(url = v.trim()) } }, label = { Text("Web sitesi (ör. roblox.com)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (e.pkg.isNotEmpty()) { AppIcon(e.pkg, 28.dp); Text("  " + appLabel(ctx, e.pkg), color = C.text, modifier = Modifier.weight(1f)) }
                        else Text("Uygulama seçilmedi", color = C.muted, fontSize = 14.sp, modifier = Modifier.weight(1f))
                        TextButton(onClick = { picking = true }) { Text(if (e.pkg.isEmpty()) "Uygulama seç" else "Değiştir") }
                        if (e.pkg.isNotEmpty()) TextButton(onClick = { upd { it.copy(pkg = "") } }) { Text("Kaldır") }
                    }
                    OutlinedTextField(e.recovery, { v -> upd { it.copy(recovery = v) } }, label = { Text("Bağlı e-posta / telefon") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(e.note, { v -> upd { it.copy(note = v) } }, label = { Text("Not") }, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = { if (e.app.isNotBlank()) save(e) else msg = "Uygulama adını yaz" },
                            enabled = !busy, colors = ButtonDefaults.buttonColors(containerColor = C.accent),
                        ) { Text("Kaydet") }
                        OutlinedButton(onClick = { editing = null }) { Text("Vazgeç") }
                    }
                }
            } else {
                Button(
                    onClick = { editing = Vault.Entry(null, "", "", "", "", "") },
                    colors = ButtonDefaults.buttonColors(containerColor = C.accent), modifier = Modifier.fillMaxWidth(),
                ) { Text("Yeni hesap ekle") }
                val wifi = entries.filter { it.kind == "wifi" }
                val showWifiPass = app.orbit.data.Wifi.settings.value.showPasswords
                Card {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("📶 Wi-Fi ağları (${wifi.size})", color = C.text, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, modifier = Modifier.weight(1f))
                        TextButton(onClick = onWifi) { Text("Wi-Fi") }
                    }
                    OutlinedButton(onClick = { scanFor = "" }, modifier = Modifier.fillMaxWidth()) { Text("📷 QR ile ağ ekle") }
                    for (w in wifi) {
                        Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(w.app, color = C.text, fontSize = 16.sp, modifier = Modifier.weight(1f))
                                Muted(when (w.security) { "open" -> "şifresiz"; "wpa3" -> "WPA3"; "wep" -> "WEP"; else -> "WPA2" }, 12)
                            }
                            val missing = w.password.isEmpty() && w.security != "open"
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                                when {
                                    missing -> {
                                        Text("şifre eksik", color = C.warn, fontSize = 13.sp, modifier = Modifier.weight(1f))
                                        TextButton(onClick = { scanFor = w.app }) { Text("📷 QR") }
                                        TextButton(onClick = { pwFor = w }) { Text("✎ Yaz") }
                                    }
                                    !showWifiPass -> Muted("kayıtlı", 13)
                                    else -> {
                                        val show = revealed[w.id] == true
                                        Text(
                                            if (w.security == "open") "şifresiz" else if (show) w.password else "••••••••",
                                            color = C.muted, fontFamily = FontFamily.Monospace, fontSize = 14.sp, modifier = Modifier.weight(1f),
                                        )
                                        if (w.security != "open") {
                                            TextButton(onClick = { revealed[w.id ?: ""] = !show }) { Text(if (show) "🙈" else "👁") }
                                            TextButton(onClick = { copy("Wi-Fi şifresi", w.password) }) { Text("⧉") }
                                        }
                                        TextButton(onClick = { qrFor = w }) { Text("▦ QR") }
                                    }
                                }
                            }
                        }
                    }
                }
                scanFor?.let { target ->
                    QrScanner(
                        onCancel = { scanFor = null },
                        onCode = { text ->
                            val n = app.orbit.data.Wifi.parseQr(text)
                            when {
                                n == null -> { msg = "Bu bir Wi-Fi QR kodu değil"; false }
                                target.isNotEmpty() && n.ssid != target -> { msg = "Bu QR \"${n.ssid}\" ağına ait"; false }
                                else -> {
                                    scanFor = null
                                    busy = true
                                    scope.launch {
                                        val r = app.orbit.data.Wifi.saveOnly(n.ssid, n.password, n.security, n.hidden, "qr")
                                        msg = r.fold({ "${n.ssid} kaydedildi ✓" }, { it.message ?: "Kaydedilemedi" })
                                        load()
                                    }
                                    true
                                }
                            }
                        },
                    )
                }
                val apps = entries.filter { it.kind != "wifi" }
                if (apps.isEmpty()) Muted("Henüz kayıt yok.")
                for (x in apps) {
                    Card {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (x.pkg.isNotEmpty()) { AppIcon(x.pkg, 30.dp); androidx.compose.foundation.layout.Spacer(Modifier.width(8.dp)) }
                            Text(x.app, color = C.text, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, modifier = Modifier.weight(1f))
                        }
                        if (x.url.isNotEmpty() || x.pkg.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            if (x.url.isNotEmpty()) TextButton(onClick = { opened(openUrl(ctx, x.url)) }) { Text("🌐 " + x.url.removePrefix("https://").removePrefix("http://").take(28)) }
                            if (x.pkg.isNotEmpty()) OutlinedButton(onClick = { opened(openApp(ctx, x.pkg)) }) { Text("▶ Uygulamayı aç") }
                        }
                        if (x.username.isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(x.username, color = C.text, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                            TextButton(onClick = { copy("Kullanıcı adı", x.username) }) { Text("⧉") }
                        }
                        if (x.password.isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically) {
                            val show = revealed[x.id] == true
                            Text(if (show) x.password else "••••••••", color = C.text, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                            TextButton(onClick = { revealed[x.id ?: ""] = !show }) { Text(if (show) "🙈" else "👁") }
                            TextButton(onClick = { copy("Şifre", x.password) }) { Text("⧉") }
                        }
                        if (x.recovery.isNotEmpty()) Muted("Kurtarma: ${x.recovery}", 13)
                        if (x.note.isNotEmpty()) Muted(x.note, 13)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = { editing = x }) { Text("Düzenle") }
                        TextButton(onClick = {
                            if (deleteArmed == x.id) deleteEntry = x else deleteArmed = x.id
                        }) { Text(if (deleteArmed == x.id) "Tekrar bas: sil" else "Sil", color = C.bad) }
                        }
                    }
                }
            }
        }
    }
}
