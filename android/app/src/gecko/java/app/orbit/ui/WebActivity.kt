package app.orbit.ui

import android.Manifest
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.util.Log
import android.view.WindowManager
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
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
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
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.ContentBlocking
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings
import org.mozilla.geckoview.GeckoView
import org.mozilla.geckoview.WebExtension
import org.mozilla.geckoview.WebResponse
import kotlin.concurrent.thread

/** Gecko motoru: işlem başına tek. Uzantı (YouTube sadeleştirme, giriş) bir kez kurulur. */
object Gecko {
    @Volatile private var rt: GeckoRuntime? = null
    @Volatile var ext: WebExtension? = null
    private val waiting = mutableListOf<(WebExtension?) -> Unit>()
    private var extDone = false

    fun runtime(ctx: Context): GeckoRuntime = rt ?: synchronized(this) {
        rt ?: GeckoRuntime.create(
            ctx.applicationContext,
            GeckoRuntimeSettings.Builder()
                .consoleOutput(false)
                .aboutConfigEnabled(false)
                .contentBlocking(
                    ContentBlocking.Settings.Builder()
                        .antiTracking(ContentBlocking.AntiTracking.STRICT)
                        .enhancedTrackingProtectionLevel(ContentBlocking.EtpLevel.STRICT)
                        .build(),
                )
                .build(),
        ).also { r ->
            rt = r
            r.webExtensionController.ensureBuiltIn("resource://android/assets/orbitweb/", "orbitweb@orbit.app")
                .accept({ e ->
                    ext = e
                    e?.let { r.webExtensionController.setAllowedInPrivateBrowsing(it, true) }
                    done(e)
                }, { t -> Log.w("OrbitWeb", "uzantı kurulamadı", t); done(null) })
        }
    }

    @Synchronized private fun done(e: WebExtension?) {
        extDone = true
        waiting.forEach { it(e) }
        waiting.clear()
    }

    @Synchronized fun whenExt(f: (WebExtension?) -> Unit) { if (extDone) f(ext) else waiting += f }
}

/**
 * Orbit içinde web sayfası / YouTube video listesi. Adres çubuğu yok; izinli olmayan adrese gidilmez.
 * Ebeveyn modunda (panelden ya da PIN) kısıtlar kalkar ki giriş/doğrulama yapılabilsin.
 */
class WebActivity : ComponentActivity() {
    private lateinit var app: WebApps.App
    private lateinit var session: GeckoSession
    private var canBack = false
    private var url = ""
    private var title by mutableStateOf("")
    private var index by mutableIntStateOf(0)
    private var full by mutableStateOf(false)
    private var note by mutableStateOf<String?>(null)
    private var prompt by mutableStateOf<PromptUi?>(null)
    private var lastVisit = ""
    private var visitAt = 0L
    private var pendingMedia: (() -> Unit)? = null

    private val askPerms = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { pendingMedia?.invoke(); pendingMedia = null }

    private fun parent(): Boolean {
        val l = Live.state.value
        return l.snapshot?.parentMode == true || (l.pinUntil ?: 0L) > System.currentTimeMillis()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Store.init(this)
        val id = intent.getStringExtra("id")?.removePrefix(WebApps.PREFIX)
        val a = id?.let { WebApps.all()[it] }
        if (a == null) { Toast.makeText(this, "Bu sayfa artık yok", Toast.LENGTH_SHORT).show(); finish(); return }
        app = a
        title = a.title
        WindowCompat.setDecorFitsSystemWindows(window, true)

        val rt = Gecko.runtime(this)
        session = GeckoSession(
            GeckoSessionSettings.Builder()
                .usePrivateMode(!a.rememberLogin)
                .useTrackingProtection(a.strict && !a.isVideos)
                .allowJavascript(true)
                .build(),
        )
        session.navigationDelegate = nav
        session.contentDelegate = content
        session.progressDelegate = progress
        session.permissionDelegate = perms
        session.promptDelegate = prompts
        session.open(rt)
        Gecko.whenExt { e ->
            runOnUiThread {
                e?.let { session.webExtensionController.setMessageDelegate(it, messages, "orbit") }
                session.loadUri(a.startUrl(0))
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    full -> session.exitFullScreen()
                    canBack -> session.goBack()
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
                    if (parent() && !full) Text(
                        "👤 Ebeveyn modu: kısıtlar kapalı (giriş için)", color = C.text, fontSize = 13.sp,
                        modifier = Modifier.fillMaxWidth().background(C.warn.copy(alpha = 0.35f)).padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                    Box(Modifier.fillMaxWidth().weight(if (app.isVideos && !full) 0.45f else 1f).background(androidx.compose.ui.graphics.Color.Black)) {
                        AndroidView(factory = { ctx -> GeckoView(ctx).also { it.setSession(session) } }, modifier = Modifier.fillMaxSize())
                    }
                    if (app.isVideos && !full) VideoList(Modifier.weight(0.55f))
                }
                note?.let { n ->
                    AlertDialog(onDismissRequest = { note = null }, text = { Text(n) }, confirmButton = { TextButton(onClick = { note = null }) { Text("Tamam") } })
                }
                prompt?.let { PromptDialog(it) }
            }
        }
    }

    @Composable
    private fun TopBar() {
        Row(Modifier.fillMaxWidth().background(C.surface).padding(horizontal = 4.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            BarBtn("✕") { finish() }
            if (!app.isVideos) BarBtn("←") { if (canBack) session.goBack() }
            Text(
                (if (app.isVideos) "🎬 " else "🌐 ") + title.ifBlank { app.title }, color = C.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(horizontal = 6.dp),
            )
            BarBtn("⟳") { session.reload() }
        }
    }

    @Composable
    private fun BarBtn(t: String, onClick: () -> Unit) {
        Box(Modifier.clip(RoundedCornerShape(10.dp)).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 10.dp)) {
            Text(t, color = C.text, fontSize = 20.sp)
        }
    }

    @Composable
    private fun VideoList(m: Modifier) {
        Column(m.fillMaxWidth()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                BarBtn("⏮") { play(index - 1) }
                BarBtn("⏭") { play(index + 1) }
                Spacer(Modifier.weight(1f))
                Text("${index + 1} / ${app.videos.size}", color = C.muted, fontSize = 13.sp, modifier = Modifier.padding(end = 12.dp))
            }
            LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
                itemsIndexed(app.videos) { i, v ->
                    Row(
                        Modifier.fillMaxWidth().clickable { play(i) }.background(if (i == index) C.surface2 else C.bg).padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(if (i == index) "▶" else "${i + 1}.", color = if (i == index) C.accent else C.muted, fontSize = 15.sp, modifier = Modifier.width(32.dp))
                        Text(
                            (if (v.type == "playlist") "📃 " else "") + v.title.ifBlank { "Video ${i + 1}" }, color = C.text, fontSize = 15.sp,
                            maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
        }
    }

    private fun play(i: Int) {
        if (app.videos.isEmpty()) return
        val n = when {
            i < 0 -> if (app.loop) app.videos.lastIndex else 0
            i > app.videos.lastIndex -> if (app.loop) 0 else return
            else -> i
        }
        index = n
        session.loadUri(app.startUrl(n))
    }

    override fun onResume() {
        super.onResume()
        if (::app.isInitialized) WebApps.current = app.pkg
    }

    override fun onPause() {
        super.onPause()
        if (::app.isInitialized && WebApps.current == app.pkg) WebApps.current = null
    }

    override fun onDestroy() {
        if (::session.isInitialized) runCatching { session.close() }
        super.onDestroy()
    }

    // --- Gezinme denetimi ---

    private fun safeSearch(uri: String): String? {
        if (!app.safeSearch) return null
        val u = runCatching { Uri.parse(uri) }.getOrNull() ?: return null
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

    private val nav = object : GeckoSession.NavigationDelegate {
        override fun onLoadRequest(session: GeckoSession, request: GeckoSession.NavigationDelegate.LoadRequest): GeckoResult<AllowOrDeny>? {
            val uri = request.uri
            if (parent()) return GeckoResult.fromValue(AllowOrDeny.ALLOW)
            if (!app.allows(uri)) {
                blocked(uri)
                return GeckoResult.fromValue(AllowOrDeny.DENY)
            }
            safeSearch(uri)?.let { fixed -> runOnUiThread { session.loadUri(fixed) }; return GeckoResult.fromValue(AllowOrDeny.DENY) }
            return GeckoResult.fromValue(AllowOrDeny.ALLOW)
        }

        override fun onSubframeLoadRequest(session: GeckoSession, request: GeckoSession.NavigationDelegate.LoadRequest): GeckoResult<AllowOrDeny>? {
            if (parent() || app.allowsSub(request.uri)) return GeckoResult.fromValue(AllowOrDeny.ALLOW)
            return GeckoResult.fromValue(AllowOrDeny.DENY)
        }

        /** Yeni pencere/sekme açılmaz; izinliyse aynı sayfada açılır */
        override fun onNewSession(session: GeckoSession, uri: String): GeckoResult<GeckoSession>? {
            if (parent() || app.allows(uri)) runOnUiThread { session.loadUri(uri) } else blocked(uri)
            return null
        }

        override fun onCanGoBack(session: GeckoSession, canGoBack: Boolean) { canBack = canGoBack }

        override fun onLocationChange(session: GeckoSession, url: String?, perms: MutableList<GeckoSession.PermissionDelegate.ContentPermission>, hasUserGesture: Boolean) {
            val u = url ?: return
            this@WebActivity.url = u
            // Sayfa içi (tek sayfa uygulaması) gezinme onLoadRequest'e uğramaz: izinsizse geri dön
            if (!parent() && !app.allows(u)) {
                blocked(u)
                runOnUiThread { if (app.isVideos) play(if (app.autoplay) index + 1 else index) else if (canBack) session.goBack() else session.loadUri(app.startUrl()) }
                return
            }
            if (app.isVideos) app.indexOf(u).takeIf { it >= 0 }?.let { index = it }
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

    private val progress = object : GeckoSession.ProgressDelegate {}

    private val content = object : GeckoSession.ContentDelegate {
        override fun onTitleChange(session: GeckoSession, title: String?) { this@WebActivity.title = title ?: "" }

        override fun onFullScreen(session: GeckoSession, fullScreen: Boolean) {
            if (fullScreen && !app.fullscreen) { session.exitFullScreen(); return }
            full = fullScreen
            val c = WindowInsetsControllerCompat(window, window.decorView)
            if (fullScreen) {
                c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                c.hide(WindowInsetsCompat.Type.systemBars())
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                c.show(WindowInsetsCompat.Type.systemBars())
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }

        override fun onExternalResponse(session: GeckoSession, response: WebResponse) {
            if (!app.downloads && !parent()) { runOnUiThread { Toast.makeText(this@WebActivity, "İndirme kapalı", Toast.LENGTH_SHORT).show() }; return }
            runCatching {
                val name = response.headers["Content-Disposition"]?.substringAfter("filename=", "")?.trim('"', ' ', ';')?.takeIf { it.isNotBlank() }
                    ?: Uri.parse(response.uri).lastPathSegment ?: "dosya"
                val dm = getSystemService(DownloadManager::class.java)
                dm.enqueue(
                    DownloadManager.Request(Uri.parse(response.uri)).setTitle(name)
                        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name),
                )
                runOnUiThread { Toast.makeText(this@WebActivity, "İndiriliyor: $name", Toast.LENGTH_SHORT).show() }
            }.onFailure { Log.w("OrbitWeb", "indirme", it) }
        }

        override fun onCrash(session: GeckoSession) { runOnUiThread { session.open(Gecko.runtime(this@WebActivity)); session.loadUri(app.startUrl(index)) } }
        override fun onKill(session: GeckoSession) { runOnUiThread { session.open(Gecko.runtime(this@WebActivity)); session.loadUri(app.startUrl(index)) } }
    }

    // --- İzinler (kamera / mikrofon) ---

    private val perms = object : GeckoSession.PermissionDelegate {
        override fun onAndroidPermissionsRequest(session: GeckoSession, permissions: Array<out String>?, callback: GeckoSession.PermissionDelegate.Callback) {
            val need = permissions.orEmpty().filter { it == Manifest.permission.CAMERA || it == Manifest.permission.RECORD_AUDIO }
            if (!app.media || need.isEmpty()) { callback.reject(); return }
            val missing = need.filter { ContextCompat.checkSelfPermission(this@WebActivity, it) != PackageManager.PERMISSION_GRANTED }
            if (missing.isEmpty()) { callback.grant(); return }
            pendingMedia = {
                if (missing.all { ContextCompat.checkSelfPermission(this@WebActivity, it) == PackageManager.PERMISSION_GRANTED }) callback.grant() else callback.reject()
            }
            askPerms.launch(missing.toTypedArray())
        }

        override fun onContentPermissionRequest(session: GeckoSession, perm: GeckoSession.PermissionDelegate.ContentPermission): GeckoResult<Int>? =
            GeckoResult.fromValue(GeckoSession.PermissionDelegate.ContentPermission.VALUE_DENY)

        override fun onMediaPermissionRequest(
            session: GeckoSession, uri: String,
            video: Array<out GeckoSession.PermissionDelegate.MediaSource>?, audio: Array<out GeckoSession.PermissionDelegate.MediaSource>?,
            callback: GeckoSession.PermissionDelegate.MediaCallback,
        ) {
            if (!app.media) { callback.reject(); return }
            callback.grant(video?.firstOrNull(), audio?.firstOrNull())
        }
    }

    // --- Uzantı mesajları ---

    private val messages = object : WebExtension.MessageDelegate {
        override fun onMessage(nativeApp: String, message: Any, sender: WebExtension.MessageSender): GeckoResult<Any>? {
            val m = message as? JSONObject ?: return null
            return when (m.optString("t")) {
                "cfg" -> GeckoResult.fromValue(
                    JSONObject().put("yt", app.isVideos).put("parent", parent()).put("login", app.loginMode)
                        .put("hosts", JSONArray(app.hosts()))
                        .put("videos", JSONArray(app.videos.filter { it.type == "video" }.map { it.id }))
                        .put("lists", JSONArray(app.videos.filter { it.type == "playlist" }.map { it.id })),
                )
                "ended" -> {
                    runOnUiThread {
                        val cur = app.indexOf(m.optString("url"))
                        // Oynatma listesi kendi içinde ilerler; tek video bitince sıradakine geç
                        if (cur < 0 || app.videos[cur].type == "video") {
                            if (app.autoplay) play(index + 1) else if (app.loop && app.videos.size == 1) play(0)
                        }
                    }
                    GeckoResult.fromValue(JSONObject())
                }
                "blocked" -> { blocked(m.optString("url")); GeckoResult.fromValue(JSONObject()) }
                "cred" -> {
                    if (parent()) return GeckoResult.fromValue(JSONObject())
                    val r = GeckoResult<Any>()
                    val host = m.optString("host")
                    thread {
                        val c = runCatching { WebApps.credentials(app, host) }.getOrNull()
                        r.complete(if (c == null) JSONObject() else JSONObject().put("u", c.first).put("p", c.second))
                    }
                    r
                }
                else -> null
            }
        }
    }

    // --- Sayfa pencereleri (uyarı, onay, açılır liste, metin) ---

    private class PromptUi(val title: String?, val message: String?, val options: List<Pair<String, () -> Unit>>, val input: ((String) -> Unit)? = null, val dismiss: () -> Unit)

    @Composable
    private fun PromptDialog(p: PromptUi) {
        var text by androidx.compose.runtime.remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { prompt = null; p.dismiss() },
            title = p.title?.takeIf { it.isNotBlank() }?.let { t -> { Text(t) } },
            text = {
                Column {
                    p.message?.takeIf { it.isNotBlank() }?.let { Text(it) }
                    if (p.input != null) androidx.compose.material3.OutlinedTextField(text, { text = it }, singleLine = true)
                    if (p.input == null && p.options.size > 3) LazyColumn(Modifier.height(320.dp)) {
                        itemsIndexed(p.options) { _, o ->
                            Text(o.first, color = C.text, modifier = Modifier.fillMaxWidth().clickable { prompt = null; o.second() }.padding(vertical = 12.dp))
                        }
                    }
                }
            },
            confirmButton = {
                Row {
                    if (p.input != null) TextButton(onClick = { prompt = null; p.input.invoke(text) }) { Text("Tamam") }
                    else if (p.options.size <= 3) p.options.forEach { o -> TextButton(onClick = { prompt = null; o.second() }) { Text(o.first) } }
                }
            },
            dismissButton = { TextButton(onClick = { prompt = null; p.dismiss() }) { Text("Vazgeç") } },
        )
    }

    private val prompts = object : GeckoSession.PromptDelegate {
        override fun onAlertPrompt(session: GeckoSession, prompt: GeckoSession.PromptDelegate.AlertPrompt): GeckoResult<GeckoSession.PromptDelegate.PromptResponse>? {
            val r = GeckoResult<GeckoSession.PromptDelegate.PromptResponse>()
            this@WebActivity.prompt = PromptUi(prompt.title, prompt.message, listOf("Tamam" to { r.complete(prompt.dismiss()) })) { r.complete(prompt.dismiss()) }
            return r
        }

        override fun onButtonPrompt(session: GeckoSession, prompt: GeckoSession.PromptDelegate.ButtonPrompt): GeckoResult<GeckoSession.PromptDelegate.PromptResponse>? {
            val r = GeckoResult<GeckoSession.PromptDelegate.PromptResponse>()
            this@WebActivity.prompt = PromptUi(
                prompt.title, prompt.message,
                listOf("Tamam" to { r.complete(prompt.confirm(GeckoSession.PromptDelegate.ButtonPrompt.Type.POSITIVE)) }),
            ) { r.complete(prompt.confirm(GeckoSession.PromptDelegate.ButtonPrompt.Type.NEGATIVE)) }
            return r
        }

        override fun onTextPrompt(session: GeckoSession, prompt: GeckoSession.PromptDelegate.TextPrompt): GeckoResult<GeckoSession.PromptDelegate.PromptResponse>? {
            val r = GeckoResult<GeckoSession.PromptDelegate.PromptResponse>()
            this@WebActivity.prompt = PromptUi(prompt.title, prompt.message, emptyList(), input = { t -> r.complete(prompt.confirm(t)) }) { r.complete(prompt.dismiss()) }
            return r
        }

        override fun onChoicePrompt(session: GeckoSession, prompt: GeckoSession.PromptDelegate.ChoicePrompt): GeckoResult<GeckoSession.PromptDelegate.PromptResponse>? {
            val r = GeckoResult<GeckoSession.PromptDelegate.PromptResponse>()
            val flat = mutableListOf<GeckoSession.PromptDelegate.ChoicePrompt.Choice>()
            fun add(cs: Array<out GeckoSession.PromptDelegate.ChoicePrompt.Choice>?) {
                cs?.forEach { c -> if (c.items != null) add(c.items) else if (!c.separator && !c.disabled) flat += c }
            }
            add(prompt.choices)
            this@WebActivity.prompt = PromptUi(
                prompt.title, prompt.message,
                flat.map { c -> c.label to { r.complete(prompt.confirm(c)) } },
            ) { r.complete(prompt.dismiss()) }
            return r
        }
    }
}
