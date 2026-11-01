package app.orbit.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log
import app.orbit.BuildConfig
import app.orbit.data.Store
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
    private fun msg(s: String) = Store.prefs().edit().putString("updateStatus", s).apply()

    fun check(ctx: Context, installIfNew: Boolean = true) {
        Store.init(ctx)
        val token = Store.updateToken
        if (token.isBlank()) { checkPublic(ctx, installIfNew); return }
        try {
            val c = open("https://api.github.com/repos/${BuildConfig.UPDATE_REPO}/releases/latest", token, "application/vnd.github+json")
            if (c.responseCode != 200) { msg("GitHub HTTP ${c.responseCode}"); return }
            val j = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            val version = j.optString("tag_name").removePrefix("orbit-v").removePrefix("v").toIntOrNull() ?: 0
            if (version <= BuildConfig.VERSION_CODE) { msg("Güncel (${BuildConfig.VERSION_CODE})"); return }
            if (!installIfNew) { msg("Yeni sürüm $version mevcut"); return }
            val assets = j.optJSONArray("assets")
            var url: String? = null
            for (i in 0 until (assets?.length() ?: 0)) {
                val a = assets!!.getJSONObject(i)
                if (a.optString("name").endsWith(".apk")) { url = a.optString("url"); break }
            }
            if (url == null) { msg("Sürüm $version içinde APK yok"); return }
            msg("Sürüm $version indiriliyor")
            install(ctx, download(url, token))
        } catch (e: Exception) {
            Log.e(TAG, "güncelleme", e)
            msg("Hata: ${e.message}")
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
            if (c.responseCode != 200) { msg("Sürüm dosyası HTTP ${c.responseCode}"); return }
            val j = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            val version = j.optInt("version")
            if (version <= BuildConfig.VERSION_CODE) { msg("Güncel (${BuildConfig.VERSION_CODE})"); return }
            if (!installIfNew) { msg("Yeni sürüm $version mevcut"); return }
            val url = j.optString("url")
            if (!url.startsWith("https://")) { msg("Sürüm dosyası hatalı"); return }
            msg("Sürüm $version indiriliyor")
            var d = open(url, null, "application/octet-stream")
            var step = 0
            while (d.responseCode in 300..399 && step < 5) {
                val next = d.getHeaderField("Location") ?: break
                d.disconnect(); d = open(next, null, "application/octet-stream"); step++
            }
            if (d.responseCode != 200) throw IllegalStateException("İndirme HTTP ${d.responseCode}")
            install(ctx, d.inputStream.use { it.readBytes() })
        } catch (e: Exception) {
            Log.e(TAG, "güncelleme (genel)", e)
            msg("Hata: ${e.message}")
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
    private fun download(addr: String, token: String): ByteArray {
        var c = open(addr, token, "application/octet-stream")
        var step = 0
        while (c.responseCode in 300..399 && step < 5) {
            val next = c.getHeaderField("Location") ?: break
            c.disconnect()
            c = open(next, null, "application/octet-stream")
            step++
        }
        if (c.responseCode != 200) throw IllegalStateException("İndirme HTTP ${c.responseCode}")
        return c.inputStream.use { it.readBytes() }
    }

    private fun install(ctx: Context, apk: ByteArray) {
        val pi = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(ctx.packageName)
        val id = pi.createSession(params)
        pi.openSession(id).use { s ->
            s.openWrite("orbit.apk", 0, apk.size.toLong()).use { it.write(apk); s.fsync(it) }
            val cb = PendingIntent.getBroadcast(ctx, id, Intent(ctx, InstallReceiver::class.java), PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            s.commit(cb.intentSender)
        }
    }
}

class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Store.init(context)
        val st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -99)
        val text = when (st) {
            PackageInstaller.STATUS_SUCCESS -> "Kuruldu"
            PackageInstaller.STATUS_PENDING_USER_ACTION -> "Kurulum onayı bekleniyor"
            else -> "Kurulum başarısız ($st)"
        }
        Store.prefs().edit().putString("updateStatus", text).apply()
    }
}
