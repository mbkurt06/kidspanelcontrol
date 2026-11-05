package app.orbit.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile

/**
 * Kanıtları ebeveynin OneDrive'ına yükler (Uygulamalar > Orbit > çocuk > tarih).
 * Büyük dosyalar 10 MB'lık parçalarla gönderilir; bağlantı koparsa kaldığı yerden devam edilir.
 * OneDrive bağlı değilse null döner: çağıran Orbit deposuna yükler.
 */
object Cloud {
    private const val TAG = "OrbitCloud"
    /** 320 KiB'nin katı olmalı */
    private const val CHUNK = 320 * 1024 * 32
    @Volatile private var offUntil = 0L

    /** Bağlı değil denildiyse 10 dk bir daha sorma */
    val available get() = System.currentTimeMillis() > offUntil

    /** Yükleme oturumu adresi; OneDrive bağlı değilse null */
    fun session(name: String): String? {
        if (!available) return null
        val (code, txt) = runCatching { Api.function("orbit-onedrive", JSONObject().put("action", "session").put("name", name)) }
            .getOrElse { throw it }
        if (code == 409 || code == 403) { offUntil = System.currentTimeMillis() + 10 * 60_000; return null }
        if (code !in 200..299) throw Api.ApiError(code, "OneDrive oturumu açılamadı: ${txt.take(160)}")
        return JSONObject(txt).getString("upload_url")
    }

    /** Dosyayı parça parça yükle; yükleme adresi verilirse oradan devam eder. Dönüş: OneDrive öğe kimliği */
    fun uploadFile(file: File, uploadUrl: String, contentType: String, onProgress: (Long) -> Unit = {}): String {
        val total = file.length()
        var offset = resumeOffset(uploadUrl)
        var resyncs = 0
        RandomAccessFile(file, "r").use { raf ->
            while (true) {
                val len = minOf(CHUNK.toLong(), total - offset).toInt()
                val buf = ByteArray(len.coerceAtLeast(0))
                raf.seek(offset); raf.readFully(buf)
                val req = Request.Builder().url(uploadUrl)
                    .header("Content-Range", "bytes $offset-${offset + len - 1}/$total")
                    .put(buf.toRequestBody(contentType.toMediaType()))
                    .build()
                Api.bigClient.newCall(req).execute().use { r ->
                    val txt = r.body?.string().orEmpty()
                    when (r.code) {
                        200, 201 -> return JSONObject(txt).getString("id")
                        202 -> {
                            offset += len
                            onProgress(offset)
                        }
                        // Sunucu başka bir yerden devam bekliyor: beklediği yeri sor, oradan sürdür
                        416, 409 -> { offset = resumeOffset(uploadUrl); if (++resyncs > 5) throw Api.ApiError(r.code, "OneDrive yükleme sırası bozuldu") }
                        else -> throw Api.ApiError(r.code, "OneDrive yükleme hatası (${r.code}) ${txt.take(160)}")
                    }
                }
                if (offset >= total) offset = resumeOffset(uploadUrl)
            }
        }
    }

    fun uploadBytes(bytes: ByteArray, name: String, contentType: String): String? {
        val url = session(name) ?: return null
        val tmp = File.createTempFile("orbit-up", ".bin")
        return try {
            tmp.writeBytes(bytes)
            uploadFile(tmp, url, contentType)
        } finally { tmp.delete() }
    }

    /** Oturumun beklediği sonraki bayt (yarım kalan yüklemede) */
    private fun resumeOffset(uploadUrl: String): Long = runCatching {
        Api.bigClient.newCall(Request.Builder().url(uploadUrl).get().build()).execute().use { r ->
            if (!r.isSuccessful) return 0L
            val a = JSONObject(r.body?.string().orEmpty()).optJSONArray("nextExpectedRanges") ?: return 0L
            a.optString(0).substringBefore('-').toLongOrNull() ?: 0L
        }
    }.getOrDefault(0L)

    /** Büyük video için ücretsiz (Wi-Fi) bağlantı var mı */
    fun unmetered(ctx: Context): Boolean = runCatching {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }.getOrDefault(false)

    fun log(msg: String, t: Throwable? = null) = Log.w(TAG, msg, t)
}
