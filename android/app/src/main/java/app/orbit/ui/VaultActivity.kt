package app.orbit.ui

import android.app.KeyguardManager
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import app.orbit.data.Store
import app.orbit.data.Vault
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Çocuğun şifre kasası: uygulama hesaplarını kaydeder, kullanıcı adı/şifreyi kopyalar.
 * Açmak için telefonun kilit ekranı (PIN/parmak izi) istenir. Kopyalanan şifre 30 sn sonra panodan silinir.
 */
class VaultActivity : ComponentActivity() {
    private var unlocked by mutableStateOf(false)
    private var state by mutableStateOf<Vault.State?>(null)
    private var entries by mutableStateOf<List<Vault.Entry>>(emptyList())
    private var editing by mutableStateOf<Vault.Entry?>(null)
    private var msg by mutableStateOf("")
    private var busy by mutableStateOf(false)
    private var deleteArmed: String? by mutableStateOf(null)
    private val revealed = mutableStateMapOf<String, Boolean>()
    private val handler = Handler(Looper.getMainLooper())

    private val auth = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        if (r.resultCode == RESULT_OK) { unlocked = true; load() } else finish()
    }

    override fun onDestroy() {
        UiGuard.release()
        super.onDestroy()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        UiGuard.hold()
        super.onCreate(savedInstanceState)
        Store.init(this)
        val km = getSystemService(KeyguardManager::class.java)
        if (km.isDeviceSecure) {
            @Suppress("DEPRECATION")
            val i = km.createConfirmDeviceCredentialIntent("Şifrelerim", "Kasayı açmak için telefon kilidini gir")
            if (i != null) auth.launch(i) else { unlocked = true; load() }
        } else {
            unlocked = true
            load()
        }
        setContent { OrbitTheme { Screen() } }
    }

    private fun load() {
        busy = true
        lifecycleScope.launch {
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

    private fun copy(label: String, text: String) {
        val cm = getSystemService(ClipboardManager::class.java)
        val clip = ClipData.newPlainText(label, text)
        if (Build.VERSION.SDK_INT >= 33) {
            clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
        }
        cm.setPrimaryClip(clip)
        msg = "$label kopyalandı (30 sn sonra silinir)"
        handler.removeCallbacksAndMessages(null)
        handler.postDelayed({
            runCatching { cm.clearPrimaryClip() }
            msg = ""
        }, 30_000)
    }

    private fun save(e: Vault.Entry) {
        val s = state as? Vault.State.Open ?: return
        busy = true
        lifecycleScope.launch {
            val prev = entries.firstOrNull { it.id == e.id && e.id != null }
            val r = withContext(Dispatchers.IO) { runCatching { Vault.save(s.key, e, prev) } }
            if (r.isSuccess) { editing = null; load() } else { msg = "Kaydedilemedi"; busy = false }
        }
    }

    @Composable
    private fun Screen() {
        Column(
            Modifier.fillMaxSize().background(C.bg).safeDrawingPadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Şifrelerim", color = C.text, fontSize = 26.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                TextButton(onClick = { finish() }) { Text("Kapat") }
            }
            if (!unlocked) return@Column
            if (msg.isNotEmpty()) Text(msg, color = C.good, fontSize = 13.sp)
            when (val s = state) {
                null -> Muted(if (busy) "Açılıyor…" else "")
                Vault.State.None -> Card {
                    Title("Kasa henüz yok")
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Info("Uygulama hesaplarının kullanıcı adı ve şifrelerini burada saklayabilirsin. Sadece sen ve ebeveynlerin görebilir.")
                    }
                    Button(onClick = {
                        busy = true
                        lifecycleScope.launch {
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
                    if (e != null) EditForm(e) else {
                        Button(
                            onClick = { editing = Vault.Entry(null, "", "", "", "", "") },
                            colors = ButtonDefaults.buttonColors(containerColor = C.accent), modifier = Modifier.fillMaxWidth(),
                        ) { Text("Yeni hesap ekle") }
                        if (entries.isEmpty()) Muted("Henüz kayıt yok.")
                        for (x in entries) EntryCard(x)
                    }
                }
            }
        }
    }

    @Composable
    private fun EntryCard(x: Vault.Entry) {
        Card {
            Text(x.app, color = C.text, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
            if (x.username.isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically) {
                Text(x.username, color = C.text, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                OutlinedButton(onClick = { copy("Kullanıcı adı", x.username) }) { Text("Kopyala") }
            }
            if (x.password.isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically) {
                val show = revealed[x.id] == true
                Text(if (show) x.password else "••••••••", color = C.text, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                TextButton(onClick = { revealed[x.id ?: ""] = !show }) { Text(if (show) "Gizle" else "Göster") }
                OutlinedButton(onClick = { copy("Şifre", x.password) }) { Text("Kopyala") }
            }
            if (x.recovery.isNotEmpty()) Muted("Kurtarma: ${x.recovery}", 13)
            if (x.note.isNotEmpty()) Muted(x.note, 13)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { editing = x }) { Text("Düzenle") }
                TextButton(onClick = {
                    if (deleteArmed == x.id) lifecycleScope.launch {
                        withContext(Dispatchers.IO) { runCatching { Vault.remove(x.id!!) } }
                        deleteArmed = null
                        load()
                    } else deleteArmed = x.id
                }) { Text(if (deleteArmed == x.id) "Tekrar bas: sil" else "Sil", color = C.bad) }
            }
        }
    }

    @Composable
    private fun EditForm(e: Vault.Entry) {
        fun upd(f: (Vault.Entry) -> Vault.Entry) { editing = editing?.let(f) }
        Card {
            Title(if (e.id == null) "Yeni hesap" else "Düzenle")
            OutlinedTextField(e.app, { v -> upd { it.copy(app = v) } }, label = { Text("Uygulama / site") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(e.username, { v -> upd { it.copy(username = v) } }, label = { Text("Kullanıcı adı / e-posta") }, modifier = Modifier.fillMaxWidth())
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(e.password, { v -> upd { it.copy(password = v) } }, label = { Text("Şifre") }, modifier = Modifier.weight(1f))
                TextButton(onClick = { val p = Vault.generatePassword(); upd { it.copy(password = p) } }) { Text("Üret") }
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
    }
}
