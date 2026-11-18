package app.orbit.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log
import app.orbit.BuildConfig
import app.orbit.data.Store
import app.orbit.data.Sync
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Uzaktan güncelleme (Noor ile aynı yöntem): gizli GitHub deposundaki en son sürümü kontrol eder,
 * daha yeniyse indirip sessizce kurar (Orbit cihaz sahibi olduğu için onay sorulmaz).
 */
object Updater {
    private const val TAG = "OrbitUpdate"

    fun status(): String = Store.prefs().getString("updateStatus", "") ?: ""
    /** Hakkında ekranı canlı izler (indirme yüzdesi) */
    val live = kotlinx.coroutines.flow.MutableStateFlow("")
    private fun msg(s: String, target: Int? = null, error: String? = null) {
        Store.prefs().edit().putString("updateStatus", s).apply()
        live.value = s
        runCatching { Sync.pushUpdateStatus(s, target, error) }
    }
    @Volatile private var target = 0

    private val busy = java.util.concurrent.atomic.AtomicBoolean(false)
    @Volatile private var installStarted = 0L

    /** Aynı anda tek kontrol/indirme: yoksa periyodik kontrol ve panel komutu aynı dosyayı birlikte indirir, yüzde zıplar */
    fun check(ctx: Context, installIfNew: Boolean = true) {
        // Kurulum başlatıldıysa 3 dk bekle (Android kurarken yeniden indirme olmasın)
        if (System.currentTimeMillis() - installStarted < 180_000) return
        if (!busy.compareAndSet(false, true)) return
        try { checkOnce(ctx, installIfNew) } finally { busy.set(false) }
    }

    private fun checkOnce(ctx: Context, installIfNew: Boolean) {
        Store.init(ctx)
        // Gizli depodan güncelleme için GitHub anahtarı panelden gelir (Ayarlar → Telefon güncellemeleri)
        runCatching { app.orbit.data.Api.rpc("device_update_token", org.json.JSONObject()).trim().trim('"') }.getOrNull()
            ?.takeIf { it.isNotBlank() && it != "null" }?.let { if (it != Store.updateToken) Store.updateToken = it }
        val token = Store.updateToken
        if (token.isBlank()) { checkPublic(ctx, installIfNew); return }
        try {
            val c = open("https://api.github.com/repos/${BuildConfig.UPDATE_REPO}/releases/latest", token, "application/vnd.github+json")
            // Anahtar geçersizse yedek kurulum dosyasına dön
            if (c.responseCode == 401 || c.responseCode == 403 || c.responseCode == 404) { checkPublic(ctx, installIfNew); return }
            if (c.responseCode != 200) { msg("GitHub HTTP ${c.responseCode}", error = "GitHub HTTP ${c.responseCode}"); return }
            val j = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            val version = j.optString("tag_name").removePrefix("orbit-v").removePrefix("v").toIntOrNull() ?: 0
            if (version <= BuildConfig.VERSION_CODE) { msg("Güncel (${BuildConfig.VERSION_CODE})", version); return }
            if (!installIfNew) { msg("Yeni sürüm $version mevcut", version); return }
            val assets = j.optJSONArray("assets")
            var url: String? = null
            for (i in 0 until (assets?.length() ?: 0)) {
                val a = assets!!.getJSONObject(i)
                if (a.optString("name").endsWith(".apk")) { url = a.optString("url"); break }
            }
            if (url == null) { msg("Sürüm $version içinde APK yok", version, "APK bulunamadı"); return }
            msg("Sürüm $version indiriliyor", version)
            target = version
            install(ctx, download(ctx, url, token), version)
        } catch (e: Throwable) {
            Log.e(TAG, "güncelleme", e)
            msg("Hata: ${e.message}", error = e.message)
        }
    }

    /**
     * Anahtar yoksa ebeveyn panelindeki herkese açık sürüm dosyasına bakar (kurulum/version.json).
     * APK, Orbit'in imza anahtarıyla imzalı olmak zorunda; başka imzalı dosyayı Android zaten kurmaz.
     */
    private const val PUBLIC_MANIFEST = "https://orbit-panel-nu.vercel.app/kurulum/version.json"

    private fun checkPublic(ctx: Context, installIfNew: Boolean) {
        try {
            val c = open(PUBLIC_MANIFEST, null, "application/json")
            if (c.responseCode != 200) { msg("Sürüm dosyası HTTP ${c.responseCode}", error = "Manifest HTTP ${c.responseCode}"); return }
            val j = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            val version = j.optInt("version")
            if (version <= BuildConfig.VERSION_CODE) { msg("Güncel (${BuildConfig.VERSION_CODE})", version); return }
            if (!installIfNew) { msg("Yeni sürüm $version mevcut", version); return }
            val url = j.optString("url")
            if (!url.startsWith("https://")) { msg("Sürüm dosyası hatalı", version, "APK URL hatalı"); return }
            msg("Sürüm $version indiriliyor", version)
            target = version
            var d = open(url, null, "application/octet-stream")
            var step = 0
            while (d.responseCode in 300..399 && step < 5) {
                val next = d.getHeaderField("Location") ?: break
                d.disconnect(); d = open(next, null, "application/octet-stream"); step++
            }
            if (d.responseCode != 200) throw IllegalStateException("İndirme HTTP ${d.responseCode}")
            install(ctx, save(ctx, d), version)
        } catch (e: Throwable) {
            Log.e(TAG, "güncelleme (genel)", e)
            msg("Hata: ${e.message}", error = e.message)
        }
    }

    private fun open(addr: String, token: String?, accept: String): HttpURLConnection =
        (URL(addr).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000; readTimeout = 60_000
            instanceFollowRedirects = false
            setRequestProperty("User-Agent", "Orbit/${BuildConfig.VERSION_CODE}")
            setRequestProperty("Accept", accept)
            if (token != null) setRequestProperty("Authorization", "Bearer $token")
        }

    /** GitHub dosya adresi başka sunucuya yönlendirir; yetki başlığı oraya gönderilmez. */
    /**
     * APK belleğe değil dosyaya yazılır: büyük kurulum dosyası (Gecko ile ~120 MB) bellekte tutulunca
     * küçük bellekli telefonlarda OutOfMemoryError olur ve indirme sessizce takılırdı.
     */
    private fun save(ctx: Context, c: HttpURLConnection): java.io.File {
        val f = java.io.File(ctx.cacheDir, "orbit-update.apk")
        f.delete()
        val total = c.contentLengthLong
        var done = 0L
        var lastPct = -1
        val buf = ByteArray(256 * 1024)
        c.inputStream.use { inp ->
            f.outputStream().use { out ->
                while (true) {
                    val n = inp.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    done += n
                    val pct = if (total > 0) (done * 100 / total).toInt() else -1
                    if (pct != lastPct && pct >= 0) {
                        val text = "Sürüm $target indiriliyor %$pct (${done / 1_048_576} / ${total / 1_048_576} MB)"
                        live.value = text
                        Store.prefs().edit().putString("updateStatus", text).apply()
                        // Panele her %10'da bir
                        if (pct / 10 != lastPct / 10) runCatching { Sync.pushUpdateStatus(text, target, null) }
                        lastPct = pct
                    }
                }
            }
        }
        if (total > 0 && done < total) throw IllegalStateException("İndirme yarıda kaldı (${done / 1_048_576} / ${total / 1_048_576} MB)")
        msg("Sürüm $target kuruluyor", target)
        return f
    }

    private fun download(ctx: Context, addr: String, token: String): java.io.File {
        var c = open(addr, token, "application/octet-stream")
        var step = 0
        while (c.responseCode in 300..399 && step < 5) {
            val next = c.getHeaderField("Location") ?: break
            c.disconnect()
            c = open(next, null, "application/octet-stream")
            step++
        }
        if (c.responseCode != 200) throw IllegalStateException("İndirme HTTP ${c.responseCode}")
        return save(ctx, c)
    }

    private fun install(ctx: Context, apk: java.io.File, version: Int) {
        Store.prefs().edit().putInt("updateTarget", version).apply()
        installStarted = System.currentTimeMillis()
        // Panelde "uygulama yükleme engelli" açıksa Orbit kendi güncellemesi için geçici kaldırır (bir dakika içinde geri gelir)
        app.orbit.device.PhoneSettings.allowSelfInstall(ctx)
        val pi = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(ctx.packageName)
        val id = pi.createSession(params)
        pi.openSession(id).use { s ->
            s.openWrite("orbit.apk", 0, apk.length()).use { out -> apk.inputStream().use { it.copyTo(out, 256 * 1024) }; s.fsync(out) }
            val cb = PendingIntent.getBroadcast(ctx, id, Intent(ctx, InstallReceiver::class.java), PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            s.commit(cb.intentSender)
        }
    }
}

class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Store.init(context)
        val st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -99)
        val detail = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        val target = Store.prefs().getInt("updateTarget", 0).takeIf { it > 0 }
        val text = when (st) {
            PackageInstaller.STATUS_SUCCESS -> "Kuruldu"
            PackageInstaller.STATUS_PENDING_USER_ACTION -> "Kurulum onayı bekleniyor"
            else -> "Kurulum başarısız ($st)"
        }
        Store.prefs().edit().putString("updateStatus", text).apply()
        Sync.pushUpdateStatus(text, target, if (st == PackageInstaller.STATUS_SUCCESS) null else detail ?: "PackageInstaller kodu $st")
        if (st == PackageInstaller.STATUS_SUCCESS) {
            Store.lastUpdateAt = System.currentTimeMillis()
            app.orbit.data.Notifier.init(context)
            val stamp = java.text.SimpleDateFormat("dd.MM.yyyy · HH:mm", java.util.Locale("tr", "TR")).format(java.util.Date())
            app.orbit.data.Notifier.show(app.orbit.data.Notifier.CH_TASKS, 1460, "Orbit güncellendi", "Yeni sürüm $target kuruldu · $stamp", "ABOUT")
        }
    }
}
