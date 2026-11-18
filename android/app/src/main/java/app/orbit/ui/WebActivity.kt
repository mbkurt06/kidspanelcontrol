package app.orbit.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import app.orbit.data.Store
import app.orbit.data.WebApps
import app.orbit.service.Live
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import kotlin.concurrent.thread

/**
 * Orbit içinde web sayfası (Android WebView). Adres çubuğu yok; izinli olmayan adrese gidilmez.
 * Ebeveyn modunda (panelden ya da PIN) kısıtlar kalkar ki giriş/doğrulama yapılabilsin.
 */
class WebActivity : ComponentActivity() {
    private lateinit var app: WebApps.App
    private lateinit var web: WebView
    @Volatile private var url = ""
    private var title by mutableStateOf("")
    private var full by mutableStateOf(false)
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private var lastVisit = ""
    private var visitAt = 0L
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermission: PermissionRequest? = null
    private val script by lazy { runCatching { assets.open("orbitweb/content.js").bufferedReader().use { it.readText() } }.getOrDefault("") }

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }
    private val askPerms = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
        val p = pendingPermission ?: return@registerForActivityResult
        pendingPermission = null
        if (res.values.all { it }) p.grant(p.resources) else p.deny()
    }

    private fun parent(): Boolean {
        val l = Live.state.value
        return l.snapshot?.parentMode == true || (l.pinUntil ?: 0L) > System.currentTimeMillis()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Store.init(this)
        val id = intent.getStringExtra("id")?.removePrefix(WebApps.PREFIX)
        val a = id?.let { WebApps.all()[it] }
        if (a == null) { Toast.makeText(this, "Bu sayfa artık yok", Toast.LENGTH_SHORT).show(); finish(); return }
        app = a
        title = a.title
        WindowCompat.setDecorFitsSystemWindows(window, true)

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.setSupportMultipleWindows(false)
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.setGeolocationEnabled(false)
            settings.builtInZoomControls = true
            settings.displayZoomControls = false
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, !a.strict)
            addJavascriptInterface(Bridge(), "OrbitBridge")
            webViewClient = client
            webChromeClient = chrome
            setDownloadListener { dlUrl, ua, disposition, mime, _ -> download(dlUrl, ua, disposition, mime) }
        }
        web.loadUrl(a.startUrl(0))

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    full -> chrome.onHideCustomView()
                    web.canGoBack() -> web.goBack()
                    else -> finish()
                }
            }
        })

        lifecycleScope.launch {
            WebApps.close.collect { c ->
                if (c != null && c.first == app.pkg) {
                    WebApps.clearClose()
                    finish()
                }
            }
        }

        setContent {
            OrbitTheme {
                Column(Modifier.fillMaxSize().background(C.bg).let { if (full) it else it.statusBarsPadding() }) {
                    if (!full) TopBar()
                    Box(Modifier.fillMaxWidth().weight(1f).background(androidx.compose.ui.graphics.Color.White)) {
                        AndroidView(factory = { web }, modifier = Modifier.fillMaxSize())
                    }
                }
            }
        }
    }

    @Composable
    private fun TopBar() {
        val live by Live.state.collectAsState()
        val pm = live.snapshot?.parentMode == true || (live.pinUntil ?: 0L) > System.currentTimeMillis()
        // Ebeveyn modu bitince izinli ana sayfaya dön (kısıtlar geri gelir)
        val wasPm = remember { mutableStateOf(pm) }
        LaunchedEffect(pm) {
            if (wasPm.value && !pm && !app.allows(url)) web.loadUrl(app.startUrl())
            wasPm.value = pm
        }
        Row(Modifier.fillMaxWidth().background(C.surface).padding(horizontal = 4.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            BarBtn("✕") { finish() }
            BarBtn("←") { if (web.canGoBack()) web.goBack() }
            Text(
                "🌐 " + title.ifBlank { app.title }, color = C.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(horizontal = 6.dp),
            )
            BarBtn("⟳") { if (url.isBlank() || (!pm && !app.allows(url))) web.loadUrl(app.startUrl()) else web.reload() }
        }
        if (pm) Text(
            "👤 Ebeveyn modu: kısıtlar kapalı (giriş / doğrulama için). Bitince ⟳.",
            color = C.text, fontSize = 13.sp,
            modifier = Modifier.fillMaxWidth().background(C.warn.copy(alpha = 0.35f)).padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }

    @Composable
    private fun BarBtn(t: String, onClick: () -> Unit) {
        Box(Modifier.clip(RoundedCornerShape(10.dp)).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 10.dp)) {
            Text(t, color = C.text, fontSize = 20.sp)
        }
    }

    override fun onResume() {
        super.onResume()
        if (::app.isInitialized) WebApps.current = app.pkg
        if (::web.isInitialized) web.onResume()
    }

    override fun onPause() {
        super.onPause()
        if (::app.isInitialized && WebApps.current == app.pkg) WebApps.current = null
        if (::web.isInitialized) web.onPause()
        runCatching { CookieManager.getInstance().flush() }
    }

    override fun onDestroy() {
        if (::web.isInitialized) {
            runCatching { (web.parent as? ViewGroup)?.removeView(web); web.destroy() }
            // "Girişi hatırla" kapalıysa çerezler silinir (her açılışta çıkış yapılmış olur)
            if (::app.isInitialized && !app.rememberLogin) runCatching { CookieManager.getInstance().removeAllCookies(null) }
        }
        super.onDestroy()
    }

    // --- Gezinme denetimi ---

    private fun safeSearch(uri: String): String? {
        if (!app.safeSearch) return null
        val u = runCatching { Uri.parse(uri) }.getOrNull()?.takeIf { it.isHierarchical } ?: return null
        val h = u.host?.lowercase() ?: return null
        val path = u.path ?: ""
        val (key, value) = when {
            h.contains("google.") && path.startsWith("/search") -> "safe" to "active"
            h.endsWith("bing.com") && path.startsWith("/search") -> "adlt" to "strict"
            h.endsWith("duckduckgo.com") && u.getQueryParameter("q") != null -> "kp" to "1"
            else -> return null
        }
        if (u.getQueryParameter(key) == value) return null
        return u.buildUpon().appendQueryParameter(key, value).build().toString()
    }

    private fun blocked(uri: String) {
        thread { WebApps.visit(app, uri, null, true) }
        runOnUiThread { Toast.makeText(this, "🚫 Bu sayfa izinli değil", Toast.LENGTH_SHORT).show() }
    }

    private val client = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url.toString()
            if (!request.isForMainFrame) return false
            // Başka uygulamaya geçiş (intent:, market:, tel: …) hiçbir zaman
            val scheme = request.url.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") { if (!parent()) blocked(uri); return true }
            if (parent()) return false
            if (!app.allows(uri)) { blocked(uri); return true }
            safeSearch(uri)?.let { view.loadUrl(it); return true }
            return false
        }

        /** Sıkı mod: sayfanın parçaları da yalnız izinli sitelerden yüklenir (reklamlar kaybolur) */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (request.isForMainFrame || parent()) return null
            val u = request.url.toString()
            if (app.allowsSub(u)) return null
            return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }

        override fun onPageStarted(view: WebView, u: String, favicon: Bitmap?) {
            url = u
        }

        override fun onPageFinished(view: WebView, u: String) {
            url = u
            if (script.isNotEmpty()) view.evaluateJavascript(script, null)
        }

        /** Sayfa içi (tek sayfa uygulaması) gezinme shouldOverrideUrlLoading'e uğramaz: izinsizse geri dön */
        override fun doUpdateVisitedHistory(view: WebView, u: String, isReload: Boolean) {
            url = u
            if (u.startsWith("about:") || u.startsWith("data:")) return
            if (!parent() && !app.allows(u)) {
                blocked(u)
                if (view.canGoBack()) view.goBack() else view.loadUrl(app.startUrl())
                return
            }
            scheduleVisit()
        }
    }

    private fun scheduleVisit() {
        val u = url
        window.decorView.postDelayed({
            if (u != url || u == lastVisit || u.startsWith("about:")) return@postDelayed
            if (System.currentTimeMillis() - visitAt < 1500) return@postDelayed
            lastVisit = u
            visitAt = System.currentTimeMillis()
            val t = title
            thread { WebApps.visit(app, u, t, false) }
        }, 2500)
    }

    private val chrome = object : WebChromeClient() {
        override fun onReceivedTitle(view: WebView, t: String?) { title = t ?: "" }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (!app.fullscreen) { callback.onCustomViewHidden(); return }
            customView = view
            customCallback = callback
            (window.decorView as FrameLayout).addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            full = true
            val c = WindowInsetsControllerCompat(window, window.decorView)
            c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            c.hide(WindowInsetsCompat.Type.systemBars())
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }

        override fun onHideCustomView() {
            customView?.let { (window.decorView as FrameLayout).removeView(it) }
            customView = null
            customCallback?.onCustomViewHidden()
            customCallback = null
            full = false
            WindowInsetsControllerCompat(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread {
                val wants = request.resources.toSet()
                val media = wants.all { it == PermissionRequest.RESOURCE_VIDEO_CAPTURE || it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                if (!app.media || !media) { request.deny(); return@runOnUiThread }
                val need = buildList {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE in wants) add(Manifest.permission.CAMERA)
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE in wants) add(Manifest.permission.RECORD_AUDIO)
                }.filter { ContextCompat.checkSelfPermission(this@WebActivity, it) != PackageManager.PERMISSION_GRANTED }
                if (need.isEmpty()) request.grant(request.resources)
                else { pendingPermission = request; askPerms.launch(need.toTypedArray()) }
            }
        }

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return runCatching { pickFiles.launch(params.createIntent()); true }.getOrElse { fileCallback = null; false }
        }
    }

    private fun download(dlUrl: String, ua: String?, disposition: String?, mime: String?) {
        if (!app.downloads && !parent()) { Toast.makeText(this, "İndirme kapalı", Toast.LENGTH_SHORT).show(); return }
        runCatching {
            val name = URLUtil.guessFileName(dlUrl, disposition, mime)
            val req = DownloadManager.Request(Uri.parse(dlUrl)).setTitle(name).setMimeType(mime)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            CookieManager.getInstance().getCookie(dlUrl)?.let { req.addRequestHeader("Cookie", it) }
            ua?.let { req.addRequestHeader("User-Agent", it) }
            getSystemService(DownloadManager::class.java).enqueue(req)
            Toast.makeText(this, "İndiriliyor: $name", Toast.LENGTH_SHORT).show()
        }.onFailure { Log.w("OrbitWeb", "indirme", it) }
    }

    /** Sayfadaki betikle köprü (kasadan giriş, engellenen bağlantı bildirimi) */
    inner class Bridge {
        @JavascriptInterface
        fun call(json: String): String {
            val m = runCatching { JSONObject(json) }.getOrNull() ?: return "null"
            val pageHost = runCatching { Uri.parse(url).host }.getOrNull()?.lowercase() ?: ""
            return when (m.optString("t")) {
                "cfg" -> JSONObject().put("yt", false).put("parent", parent()).put("login", app.loginMode)
                    .put("hosts", JSONArray(app.hosts())).put("videos", JSONArray()).put("lists", JSONArray()).toString()
                "blocked" -> { blocked(m.optString("url")); "{}" }
                "cred" -> {
                    // Sadece o an açık olan (izinli) sitenin kendi giriş bilgisi; sayfanın söylediği adrese güvenilmez
                    if (parent() || pageHost.isBlank()) return "{}"
                    val c = runCatching { WebApps.credentials(app, pageHost) }.getOrNull() ?: return "{}"
                    JSONObject().put("u", c.first).put("p", c.second).toString()
                }
                else -> "null"
            }
        }
    }
}
