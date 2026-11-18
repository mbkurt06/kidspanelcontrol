package app.orbit.data

import android.net.Uri
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

/**
 * Panelden eklenen web sayfaları ve YouTube video listeleri. Telefonda Orbit'in kendi tarayıcısında
 * (adres çubuğu yok) uygulama gibi açılır; paket adı "web:<id>". Grup/durum/özel kural child_apps'tan gelir.
 */
object WebApps {
    private const val TAG = "OrbitWeb"
    const val PREFIX = "web:"

    data class Video(val type: String, val id: String, val title: String)

    data class App(
        val id: String,
        val kind: String,
        val title: String,
        val url: String,
        val domains: List<String>,
        val videos: List<Video>,
        val autoplay: Boolean,
        val loop: Boolean,
        val strict: Boolean,
        val history: Boolean,
        val downloads: Boolean,
        val media: Boolean,
        val fullscreen: Boolean,
        val safeSearch: Boolean,
        val rememberLogin: Boolean,
        val loginMode: String,
    ) {
        val pkg get() = PREFIX + id
        val isVideos get() = kind == "videos"

        /** Ana sayfa (videolarda ilk öğe) */
        fun startUrl(index: Int = 0): String {
            if (!isVideos) return url
            val v = videos.getOrNull(index) ?: return "about:blank"
            return if (v.type == "playlist") "https://m.youtube.com/playlist?list=${v.id}" else "https://m.youtube.com/watch?v=${v.id}"
        }

        /** Sitenin izinli alan adları (alt alan adları dahil) */
        fun hosts(): List<String> = if (isVideos) YT_HOSTS
        else (listOfNotNull(hostOf(url)) + domains.mapNotNull { hostOf(it) ?: it.trim().lowercase().removePrefix("www.").takeIf { d -> d.isNotBlank() } }).distinct()

        /** Üst sayfa (ana çerçeve) bu adrese gidebilir mi */
        fun allows(uri: String): Boolean {
            if (uri.startsWith("about:") || uri.startsWith("blob:") || uri.startsWith("data:")) return true
            val u = runCatching { Uri.parse(uri) }.getOrNull()?.takeIf { it.isHierarchical } ?: return false
            if (u.scheme != "https" && u.scheme != "http") return false
            val h = (u.host ?: return false).lowercase()
            if (!isVideos) return hosts().any { h == it || h.endsWith(".$it") }
            // AB çerez onayı sayfası (consent.youtube.com / consent.google.com)
            if (h.startsWith("consent.") && (h.endsWith("youtube.com") || h.contains("google."))) return true
            if (YT_HOSTS.none { h == it || h.endsWith(".$it") }) return false
            val v = u.getQueryParameter("v") ?: Regex("^/(shorts|embed|live)/([\\w-]{6,})").find(u.path ?: "")?.groupValues?.get(2)
            val list = u.getQueryParameter("list")
            return when {
                list != null && videos.any { it.type == "playlist" && it.id == list } -> true
                v != null -> videos.any { it.type == "video" && it.id == v }
                else -> false
            }
        }

        /** Alt çerçeve / içerik bu adresten yüklenebilir mi (sıkı mod) */
        fun allowsSub(uri: String): Boolean {
            if (!strict || isVideos) return true
            val h = runCatching { Uri.parse(uri).host }.getOrNull()?.lowercase() ?: return true
            return hosts().any { h == it || h.endsWith(".$it") }
        }

        fun indexOf(uri: String): Int {
            // about:blank gibi hiyerarşik olmayan adreslerde getQueryParameter hata fırlatır
            val u = runCatching { Uri.parse(uri) }.getOrNull()?.takeIf { it.isHierarchical } ?: return -1
            val v = u.getQueryParameter("v")
            val list = u.getQueryParameter("list")
            return videos.indexOfFirst { (it.type == "playlist" && it.id == list) || (it.type == "video" && it.id == v) }
        }
    }

    val YT_HOSTS = listOf("youtube.com", "youtube-nocookie.com", "youtu.be")

    fun hostOf(s: String?): String? {
        if (s.isNullOrBlank()) return null
        val t = s.trim().let { if (it.contains("://")) it else "https://$it" }
        return runCatching { Uri.parse(t).host }.getOrNull()?.lowercase()?.removePrefix("www.")?.takeIf { it.contains('.') }
    }

    private val _apps = MutableStateFlow<Map<String, App>>(emptyMap())
    val apps: StateFlow<Map<String, App>> = _apps.asStateFlow()

    fun byPkg(pkg: String): App? = if (pkg.startsWith(PREFIX)) all()[pkg.removePrefix(PREFIX)] else null

    fun all(): Map<String, App> {
        if (_apps.value.isEmpty()) runCatching { Store.prefs().getString("web.cache", null)?.let { _apps.value = parse(JSONArray(it)) } }
        return _apps.value
    }

    fun store(arr: JSONArray) {
        _apps.value = parse(arr)
        runCatching { Store.prefs().edit().putString("web.cache", arr.toString()).apply() }
    }

    private fun parse(arr: JSONArray): Map<String, App> = (0 until arr.length()).mapNotNull { i ->
        val o = arr.getJSONObject(i)
        runCatching {
            val d = o.optJSONArray("allowed_domains") ?: JSONArray()
            val v = o.optJSONArray("videos") ?: JSONArray()
            App(
                o.getString("id"), o.optString("kind", "site"), o.optString("title"), o.optString("url").takeIf { !o.isNull("url") } ?: "",
                (0 until d.length()).map { d.optString(it) }.filter { it.isNotBlank() },
                (0 until v.length()).mapNotNull { k -> v.optJSONObject(k)?.let { Video(it.optString("type", "video"), it.optString("id"), it.optString("title")) } }.filter { it.id.isNotBlank() },
                o.optBoolean("autoplay", true), o.optBoolean("loop"), o.optBoolean("strict", true), o.optBoolean("history", true),
                o.optBoolean("downloads"), o.optBoolean("media"), o.optBoolean("fullscreen", true), o.optBoolean("safe_search", true),
                o.optBoolean("remember_login", true), o.optString("login_mode", "auto"),
            )
        }.getOrNull()
    }.associateBy { it.id }

    // --- Açık olan web uygulaması (süre sayımı ve kilit için) ---

    /** Şu an ön planda olan web uygulamasının paketi (WebActivity onResume/onPause) */
    @Volatile var current: String? = null

    private val _close = MutableStateFlow<Pair<String, String>?>(null)
    /** Servis bir web uygulamasını kapatmak istediğinde (paket, sebep) */
    val close: StateFlow<Pair<String, String>?> = _close.asStateFlow()
    fun requestClose(pkg: String, reason: String) { if (_close.value?.first != pkg) _close.value = pkg to reason }
    fun clearClose() { _close.value = null }

    /** Ziyaret geçmişi (ağ iş parçacığında çağrılır) */
    fun visit(app: App, url: String, title: String?, blocked: Boolean) {
        if (!app.history && !blocked) return
        val c = Store.creds ?: return
        runCatching {
            Api.post("web_visits", JSONObject().put("family_id", c.familyId).put("child_id", c.childId).put("web_app_id", app.id)
                .put("url", url.take(2000)).put("title", title?.take(300) ?: JSONObject.NULL).put("blocked", blocked))
        }.onFailure { Log.w(TAG, "ziyaret kaydedilemedi", it) }
    }

    /** Kasadan bu siteye ait giriş bilgisi (kullanıcı adı, şifre) */
    fun credentials(app: App, host: String): Pair<String, String>? {
        if (app.loginMode == "off") return null
        val h = host.lowercase().removePrefix("www.")
        if (app.hosts().none { h == it || h.endsWith(".$it") }) return null
        val st = runCatching { Vault.open() }.getOrNull() as? Vault.State.Open ?: return null
        val list = runCatching { Vault.list(st.key) }.getOrDefault(emptyList()).filter { it.kind != "wifi" && it.password.isNotBlank() }
        fun match(e: Vault.Entry): Boolean {
            val eh = hostOf(e.url) ?: return false
            return h == eh || h.endsWith(".$eh") || eh.endsWith(".$h")
        }
        val e = list.firstOrNull { match(it) }
            ?: list.firstOrNull { e -> app.hosts().any { site -> hostOf(e.url)?.let { it == site || it.endsWith(".$site") } == true } }
            ?: return null
        return e.username to e.password
    }
}
