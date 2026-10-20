package app.orbit.data

import android.util.Log
import app.orbit.BuildConfig
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Supabase ile konuşan küçük istemci (Auth + PostgREST, "orbit" şeması). */
object Api {
    private const val TAG = "OrbitApi"
    private val JSON = "application/json".toMediaType()
    private val base = BuildConfig.SUPABASE_URL
    private val key = BuildConfig.SUPABASE_KEY

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    class ApiError(val code: Int, msg: String) : IOException(msg)

    // --- Eşleştirme ---

    data class Paired(val deviceId: String, val childId: String, val familyId: String, val email: String, val password: String)

    fun pair(code: String, model: String, osVersion: String, appVersion: String, deviceOwner: Boolean): Paired {
        val body = JSONObject()
            .put("code", code).put("model", model).put("os_version", osVersion)
            .put("app_version", appVersion).put("is_device_owner", deviceOwner).put("label", model)
        val req = Request.Builder().url("$base/functions/v1/orbit-pair")
            .header("apikey", key)
            .post(body.toString().toRequestBody(JSON)).build()
        http.newCall(req).execute().use { r ->
            val txt = r.body?.string().orEmpty()
            if (!r.isSuccessful) {
                val err = runCatching { JSONObject(txt).optString("error") }.getOrDefault("")
                throw ApiError(r.code, when (err) {
                    "invalid_or_expired" -> "Kod geçersiz veya süresi dolmuş"
                    "bad_code" -> "Kod 8 haneli olmalı"
                    else -> "Sunucu hatası (${r.code})"
                })
            }
            val o = JSONObject(txt)
            if (o.optString("kind") != "child_phone") throw ApiError(400, "Bu kod bir çocuk telefonu için değil")
            return Paired(o.getString("device_id"), o.getString("child_id"), o.getString("family_id"), o.getString("email"), o.getString("password"))
        }
    }

    // --- Oturum ---

    @Synchronized
    private fun token(): String {
        val now = System.currentTimeMillis()
        Store.accessToken?.let { if (Store.tokenExpiry - 60_000 > now) return it }
        val c = Store.creds ?: throw ApiError(401, "Eşleşmemiş")
        val refresh = Store.refreshToken
        val o = if (refresh != null) {
            runCatching { authCall("refresh_token", JSONObject().put("refresh_token", refresh)) }.getOrNull()
        } else null
        val res = o ?: authCall("password", JSONObject().put("email", c.email).put("password", c.password))
        Store.accessToken = res.getString("access_token")
        Store.refreshToken = res.optString("refresh_token")
        Store.tokenExpiry = now + res.optLong("expires_in", 3600) * 1000
        return Store.accessToken!!
    }

    private fun authCall(grant: String, body: JSONObject): JSONObject {
        val req = Request.Builder().url("$base/auth/v1/token?grant_type=$grant")
            .header("apikey", key)
            .post(body.toString().toRequestBody(JSON)).build()
        http.newCall(req).execute().use { r ->
            val txt = r.body?.string().orEmpty()
            if (!r.isSuccessful) throw ApiError(r.code, "Oturum açılamadı (${r.code})")
            return JSONObject(txt)
        }
    }

    private fun rest(path: String): Request.Builder = Request.Builder()
        .url("$base/rest/v1/$path")
        .header("apikey", key)
        .header("Authorization", "Bearer ${token()}")
        .header("Accept-Profile", "orbit")
        .header("Content-Profile", "orbit")

    private fun exec(req: Request): String {
        http.newCall(req).execute().use { r ->
            val txt = r.body?.string().orEmpty()
            if (r.code == 401) {
                Store.accessToken = null
                Store.tokenExpiry = 0
            }
            if (!r.isSuccessful) {
                Log.w(TAG, "${req.method} ${req.url.encodedPath} -> ${r.code} $txt")
                throw ApiError(r.code, txt.take(200))
            }
            return txt
        }
    }

    fun get(path: String): JSONArray = JSONArray(exec(rest(path).get().build()).ifBlank { "[]" })

    fun post(path: String, body: Any, upsert: Boolean = false) {
        val b = rest(path).header("Prefer", if (upsert) "resolution=merge-duplicates,return=minimal" else "return=minimal")
        exec(b.post(body.toString().toRequestBody(JSON)).build())
    }

    fun patch(path: String, body: JSONObject) {
        exec(rest(path).header("Prefer", "return=minimal").patch(body.toString().toRequestBody(JSON)).build())
    }

    /** Storage'a dosya yükler (çocuk telefonu sadece kendi görev klasörüne yazabilir). */
    fun upload(bucket: String, path: String, bytes: ByteArray, contentType: String) {
        val req = Request.Builder()
            .url("$base/storage/v1/object/$bucket/$path")
            .header("apikey", key)
            .header("Authorization", "Bearer ${token()}")
            .header("x-upsert", "false")
            .post(bytes.toRequestBody(contentType.toMediaType()))
            .build()
        uploadClient.newCall(req).execute().use { r ->
            if (!r.isSuccessful) throw ApiError(r.code, "Yükleme başarısız (${r.code})")
        }
    }

    private val uploadClient: OkHttpClient by lazy {
        http.newBuilder().writeTimeout(120, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS).build()
    }

    fun rpc(fn: String, body: JSONObject): String = exec(rest("rpc/$fn").post(body.toString().toRequestBody(JSON)).build())
}
