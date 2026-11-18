package app.orbit.data

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * Panelden "Telefonda dene": siteyi görünmez bir tarayıcıda açar, kasadaki şifreyle giriş yapar,
 * sonucu (giriş oldu / hâlâ giriş sayfası) web_login_tests satırına yazar.
 */
object LoginTester {
    private const val TAG = "OrbitLoginTest"
    private val seen = ConcurrentHashMap.newKeySet<String>()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var busy = false

    /** Sync'ten: bekleyen denemeler (ağ iş parçacığı) */
    fun pending(arr: JSONArray) {
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val id = o.optString("id")
            if (id.isBlank() || !seen.add(id)) continue
            // 10 dakikadan eski istekler artık beklenmiyor
            val age = runCatching { System.currentTimeMillis() - Instant.parse(o.optString("created_at")).toEpochMilli() }.getOrDefault(0L)
            if (age > 10 * 60_000) { finish(id, "error", null, "İstek telefona geç ulaştı (telefon kapalıydı)"); continue }
            val app = WebApps.all()[o.optString("web_app_id")]
            if (app == null) { finish(id, "error", null, "Bu web sayfası telefonda bulunamadı"); continue }
            run(id, app)
        }
    }

    private fun finish(id: String, status: String, url: String?, msg: String) {
        runCatching {
            Api.patch("web_login_tests?id=eq.$id", JSONObject().put("status", status).put("final_url", url ?: JSONObject.NULL)
                .put("message", msg).put("done_at", Instant.now().toString()))
        }.onFailure { Log.w(TAG, "sonuç yazılamadı", it) }
    }

    private fun run(id: String, app: WebApps.App) {
        if (busy) { seen.remove(id); return } // sıradaki eşitlemede denenir
        busy = true
        runCatching { Api.patch("web_login_tests?id=eq.$id", JSONObject().put("status", "running")) }
        val start = app.loginUrl.ifBlank { app.url }
        val host = WebApps.hostOf(start) ?: ""
        val cred = runCatching { WebApps.credentials(app, host) }.getOrNull()
        if (cred == null) {
            busy = false
            finish(id, "error", null, if (app.loginMode == "off") "Bu sayfada giriş kapalı" else "Kasada bu çocuk için bu siteye ait şifre yok (ya da kasa telefonda kilitli)")
            return
        }
        main.post { browse(id, app, start, cred) }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun browse(id: String, app: WebApps.App, start: String, cred: Pair<String, String>) {
        val ctx = Store.appCtx
        val script = runCatching { ctx.assets.open("orbitweb/content.js").bufferedReader().use { it.readText() } }.getOrDefault("")
        val began = System.currentTimeMillis()
        var submittedAt = 0L
        var lastPage = began
        var done = false
        val web = WebView(ctx)
        fun end(status: String, msg: String) {
            if (done) return
            done = true
            val url = web.url
            runCatching { web.stopLoading(); web.destroy() }
            busy = false
            Thread { finish(id, status, url, msg) }.start()
        }
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        CookieManager.getInstance().setAcceptCookie(true)
        web.addJavascriptInterface(object {
            @JavascriptInterface
            fun call(json: String): String {
                val m = runCatching { JSONObject(json) }.getOrNull() ?: return "null"
                return when (m.optString("t")) {
                    "cfg" -> JSONObject().put("yt", false).put("parent", false).put("login", "auto")
                        .put("hosts", JSONArray(app.hosts())).put("videos", JSONArray()).put("lists", JSONArray()).toString()
                    "cred" -> JSONObject().put("u", cred.first).put("p", cred.second).toString()
                    "submitted" -> { submittedAt = System.currentTimeMillis(); "{}" }
                    else -> "{}"
                }
            }
        }, "OrbitBridge")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.isForMainFrame && !app.allows(request.url.toString())
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { lastPage = System.currentTimeMillis() }
            override fun onPageFinished(view: WebView, url: String?) {
                lastPage = System.currentTimeMillis()
                if (script.isNotEmpty()) view.evaluateJavascript(script, null)
            }
        }
        // Görünmez ama boyutlu: sayfa düzeni (görünür alanlar) hesaplansın
        web.measure(View.MeasureSpec.makeMeasureSpec(720, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(1280, View.MeasureSpec.EXACTLY))
        web.layout(0, 0, 720, 1280)
        web.loadUrl(start)

        val check = object : Runnable {
            override fun run() {
                if (done) return
                val now = System.currentTimeMillis()
                val quiet = now - maxOf(submittedAt, lastPage) > 6_000
                when {
                    submittedAt > 0 && quiet -> web.evaluateJavascript(
                        "(function(){var p=[].slice.call(document.querySelectorAll('input[type=password]')).filter(function(e){return e.offsetParent!==null});return p.length?'pw':'no'})()",
                    ) { r ->
                        if (r?.contains("pw") == true) end("fail", "Şifre girildi ama hâlâ giriş sayfası açık: şifre ya da kullanıcı adı yanlış olabilir")
                        else end("ok", "Giriş oldu (${cred.first.ifBlank { "kullanıcı adı yok" }})")
                    }
                    submittedAt == 0L && now - began > 25_000 -> end("fail",
                        "Giriş formu çıkmadı. Zaten girişli olabilir; emin olmak için sayfanın ayarlarına 'Giriş sayfası adresi' yaz")
                    now - began > 75_000 -> end("fail", "Süre doldu: sayfa yanıt vermedi")
                }
                if (!done) main.postDelayed(this, 2_000)
            }
        }
        main.postDelayed(check, 3_000)
    }
}
