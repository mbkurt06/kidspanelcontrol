package app.orbit.data

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Log
import app.orbit.device.Policy
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject

/**
 * Wi-Fi: telefon kilitliyken de Orbit içinden ağ tarama, bağlanma (şifre, QR, elle), kayıtlı ağlar.
 * Ağlar şifre kasasında (kind = "wifi") uçtan uca şifreli durur; panelden eklenen ağı telefon kendiliğinden tanır.
 * Onay sayfalı (giriş sayfalı) ağlarda sayfayı Orbit kendi içinde açar (PortalActivity).
 * Orbit telefon yöneticisi olduğu için Android'e ağ ekleyebilir (addNetwork), Ayarlar açılmadan.
 */
@SuppressLint("MissingPermission")
@Suppress("DEPRECATION")
object Wifi {
    private const val TAG = "OrbitWifi"

    data class Saved(val vaultId: String?, val ssid: String, val password: String, val security: String, val hidden: Boolean)
    data class Nearby(val ssid: String, val level: Int, val security: String)
    data class Status(
        val ssid: String? = null,
        val connected: Boolean = false,
        val captive: Boolean = false,
        val validated: Boolean = false,
        val connecting: String? = null,
        /** Telefonun internete çıkabildiği herhangi bir bağlantı var mı (mobil veri dahil) */
        val online: Boolean = true,
    )
    data class Settings(val childAdd: Boolean = true, val notify: Boolean = true, val showPasswords: Boolean = true)

    val saved = MutableStateFlow<List<Saved>>(emptyList())
    val nearby = MutableStateFlow<List<Nearby>>(emptyList())
    val status = MutableStateFlow(Status())
    val settings = MutableStateFlow(Settings())
    val scanning = MutableStateFlow(false)

    @Volatile var wifiNetwork: Network? = null
        private set
    @Volatile private var lastVaultSync = 0L
    private var lastPortalAutoOpen: Network? = null
    private var portalNotified: String? = null
    private lateinit var ctx: Context

    private fun wm() = ctx.getSystemService(WifiManager::class.java)
    private fun cm() = ctx.getSystemService(ConnectivityManager::class.java)

    fun init(c: Context) {
        if (::ctx.isInitialized) return
        ctx = c.applicationContext
        loadCache()
        grantPerms()
        runCatching { watch() }.onFailure { Log.w(TAG, "ağ izleme", it) }
    }

    private fun grantPerms() {
        for (p in listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) Policy.grantSelf(ctx, p)
        if (Build.VERSION.SDK_INT >= 33) Policy.grantSelf(ctx, Manifest.permission.NEARBY_WIFI_DEVICES)
    }

    // --- ayarlar ve önbellek ---

    fun applySettings(j: JSONObject?) {
        val s = Settings(j?.optBoolean("child_add", true) ?: true, j?.optBoolean("notify", true) ?: true, j?.optBoolean("show_passwords", true) ?: true)
        if (s != settings.value) {
            settings.value = s
            Store.prefs().edit().putString("wifiSettings", JSONObject().put("child_add", s.childAdd).put("notify", s.notify).put("show_passwords", s.showPasswords).toString()).apply()
        }
    }

    private fun loadCache() {
        val p = Store.prefs()
        runCatching { applySettings(JSONObject(p.getString("wifiSettings", "{}")!!)) }
        val a = runCatching { JSONArray(p.getString("wifiSaved", "[]")) }.getOrDefault(JSONArray())
        saved.value = (0 until a.length()).map { a.getJSONObject(it) }.map {
            Saved(it.optString("vaultId").ifBlank { null }, it.getString("ssid"), it.optString("password"), it.optString("security", "wpa"), it.optBoolean("hidden"))
        }
    }

    private fun storeCache(list: List<Saved>) {
        saved.value = list.sortedBy { it.ssid.lowercase() }
        val a = JSONArray()
        for (s in saved.value) a.put(JSONObject().put("vaultId", s.vaultId ?: "").put("ssid", s.ssid).put("password", s.password).put("security", s.security).put("hidden", s.hidden))
        Store.prefs().edit().putString("wifiSaved", a.toString()).apply()
    }

    private fun ours(): MutableSet<String> = Store.prefs().getStringSet("wifiOurs", emptySet())!!.toMutableSet()
    private fun setOurs(s: Set<String>) = Store.prefs().edit().putStringSet("wifiOurs", s).apply()

    // --- bağlantı durumu ---

    private fun ssidOf(caps: NetworkCapabilities?): String? {
        val info = if (Build.VERSION.SDK_INT >= 29) caps?.transportInfo as? WifiInfo else null
        val raw = info?.ssid?.takeIf { it != WifiManager.UNKNOWN_SSID } ?: runCatching { wm().connectionInfo?.ssid }.getOrNull()
        return raw?.takeIf { it != WifiManager.UNKNOWN_SSID && it.isNotBlank() }?.removeSurrounding("\"")
    }

    private fun watch() {
        val req = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build()
        val cb = if (Build.VERSION.SDK_INT >= 31) object : ConnectivityManager.NetworkCallback(ConnectivityManager.NetworkCallback.FLAG_INCLUDE_LOCATION_INFO) {
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = onWifiCaps(network, caps)
            override fun onLost(network: Network) = onWifiLost(network)
        } else object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = onWifiCaps(network, caps)
            override fun onLost(network: Network) = onWifiLost(network)
        }
        cm().registerNetworkCallback(req, cb)
        cm().registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                status.value = status.value.copy(online = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
            }
            override fun onLost(network: Network) { status.value = status.value.copy(online = false) }
        })
    }

    private fun onWifiCaps(network: Network, caps: NetworkCapabilities) {
                wifiNetwork = network
                val captive = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL)
                val validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                val ssid = ssidOf(caps)
                val was = status.value
                status.value = was.copy(ssid = ssid, connected = true, captive = captive, validated = validated)
                if (captive) onCaptive(network, ssid)
                else if (validated && was.captive && ssid != null) onPortalPassed(ssid)
    }

    private fun onWifiLost(network: Network) {
                if (network == wifiNetwork) {
                    wifiNetwork = null
                    status.value = status.value.copy(ssid = null, connected = false, captive = false, validated = false)
                    Notifier.cancel(NOTIF_PORTAL)
                }
    }

    const val NOTIF_PORTAL = 9301

    private fun onCaptive(network: Network, ssid: String?) {
        if (portalNotified != ssid) {
            portalNotified = ssid
            Notifier.show(Notifier.CH_TASKS, NOTIF_PORTAL, "📶 ${ssid ?: "Wi-Fi"} onay istiyor", "Bağlantıyı tamamlamak için dokun, onay sayfası açılır.", "WIFI")
        }
        // Ağa yeni bağlanıldıysa onay sayfasını bir kere kendiliğinden aç
        if (lastPortalAutoOpen != network) {
            lastPortalAutoOpen = network
            openPortal()
        }
    }

    private fun onPortalPassed(ssid: String) {
        Notifier.cancel(NOTIF_PORTAL)
        portalNotified = null
        val s = settings.value
        Thread { Sync.event(if (s.notify) "wifi_alert" else "wifi", JSONObject().put("action", "portal").put("ssid", ssid)) }.start()
    }

    fun openPortal() {
        val i = android.content.Intent(ctx, app.orbit.ui.PortalActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP)
        runCatching { ctx.startActivity(i) }.onFailure { Log.w(TAG, "onay sayfası açılamadı", it) }
    }

    /** Onay sayfası adresi (Android 11+ ağ bildiriyorsa), yoksa yönlendiren deneme adresi */
    fun portalUrl(): String {
        return "http://connectivitycheck.gstatic.com/generate_204"
    }

    fun recheck() { wifiNetwork?.let { n -> runCatching { cm().reportNetworkConnectivity(n, true) } } }

    // --- tarama ---

    fun securityOf(caps: String): String = when {
        caps.contains("EAP") -> "eap"
        caps.contains("PSK") -> "wpa"
        caps.contains("SAE") -> "wpa3"
        caps.contains("WEP") -> "wep"
        else -> "open"
    }

    suspend fun scan() = withContext(Dispatchers.IO) {
        scanning.value = true
        try {
            grantPerms()
            Policy.enableLocation(ctx)
            val w = wm()
            if (!w.isWifiEnabled) runCatching { w.isWifiEnabled = true }
            runCatching { w.startScan() }
            readScan()
            delay(3500)
            readScan()
        } finally { scanning.value = false }
    }

    private fun readScan() {
        val list = runCatching { wm().scanResults }.getOrNull() ?: return
        nearby.value = list.filter { !it.SSID.isNullOrBlank() }
            .groupBy { it.SSID }
            .map { (ssid, rs) ->
                val best = rs.maxBy { it.level }
                Nearby(ssid, ((best.level + 100) / 12).coerceIn(0, 4), securityOf(best.capabilities ?: ""))
            }
            .sortedByDescending { it.level }
    }

    // --- bağlanma ---

    private fun q(s: String) = "\"" + s.replace("\"", "\\\"") + "\""

    private fun configFor(ssid: String, password: String, security: String, hidden: Boolean) = WifiConfiguration().apply {
        SSID = q(ssid)
        hiddenSSID = hidden
        when (security) {
            "open" -> allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE)
            "wep" -> {
                allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE)
                allowedAuthAlgorithms.set(WifiConfiguration.AuthAlgorithm.OPEN)
                allowedAuthAlgorithms.set(WifiConfiguration.AuthAlgorithm.SHARED)
                wepKeys[0] = if (password.matches(Regex("^[0-9A-Fa-f]{10}$|^[0-9A-Fa-f]{26}$"))) password else q(password)
                wepTxKeyIndex = 0
            }
            "wpa3" -> {
                if (Build.VERSION.SDK_INT >= 30) setSecurityParams(WifiConfiguration.SECURITY_TYPE_SAE)
                preSharedKey = q(password)
            }
            else -> preSharedKey = q(password)
        }
    }

    private fun existingId(ssid: String): Int? =
        runCatching { wm().configuredNetworks }.getOrNull()?.firstOrNull { it.SSID == q(ssid) }?.networkId

    /** Android'e ağı ekler/günceller; ağ kimliği (başarısızsa -1) */
    private fun configure(ssid: String, password: String, security: String, hidden: Boolean): Int {
        val w = wm()
        val cfg = configFor(ssid, password, security, hidden)
        val old = existingId(ssid)
        val id = if (old != null) {
            cfg.networkId = old
            w.updateNetwork(cfg).takeIf { it >= 0 } ?: run { w.removeNetwork(old); w.addNetwork(cfg) }
        } else w.addNetwork(cfg)
        if (id >= 0) setOurs(ours() + ssid)
        return id
    }

    class WifiError(msg: String) : Exception(msg)

    /**
     * Ağa bağlan. how: "scan" | "qr" | "manual" | "saved". Başarılı olursa kaydedilir (kasaya da),
     * yeni ağsa ebeveyne bildirim gider.
     */
    suspend fun connect(ssid: String, password: String, security: String, hidden: Boolean, how: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val isSaved = saved.value.any { it.ssid == ssid }
            if (!isSaved && !settings.value.childAdd) throw WifiError("Yeni ağ eklemek kapalı. Ebeveynin panelden açabilir ya da ağı ekleyebilir.")
            if (security == "eap") throw WifiError("Kurumsal (kullanıcı adlı) ağlar desteklenmiyor.")
            if (security != "open" && password.length < (if (security == "wep") 5 else 8)) throw WifiError("Şifre çok kısa.")
            grantPerms()
            val w = wm()
            if (!w.isWifiEnabled) runCatching { w.isWifiEnabled = true }
            val id = configure(ssid, password, security, hidden)
            if (id < 0) throw WifiError("Ağ eklenemedi (Orbit yöneticisi değil mi?).")
            status.value = status.value.copy(connecting = ssid)
            w.disconnect()
            w.enableNetwork(id, true)
            w.reconnect()
            val ok = withTimeoutOrNull(30_000) { status.first { it.connected && it.ssid == ssid } } != null
            status.value = status.value.copy(connecting = null)
            if (!ok) throw WifiError("Bağlanamadı. Şifre yanlış ya da ağ çok uzak olabilir.")
            remember(Saved(saved.value.firstOrNull { it.ssid == ssid }?.vaultId, ssid, password, security, hidden))
            if (!isSaved) {
                val s = settings.value
                Thread { Sync.event(if (s.notify) "wifi_alert" else "wifi", JSONObject().put("action", "added").put("ssid", ssid).put("how", how)) }.start()
            }
        }.onFailure { status.value = status.value.copy(connecting = null) }
    }

    /** Kayıtlı ağa hemen bağlan */
    suspend fun connectSaved(s: Saved) = connect(s.ssid, s.password, s.security, s.hidden, "saved")

    private fun remember(s: Saved) {
        val list = saved.value.filter { it.ssid != s.ssid } + s
        storeCache(list)
        Thread { runCatching { syncVault(force = true) }.onFailure { Log.w(TAG, "kasa", it) } }.start()
    }

    suspend fun forget(s: Saved) = withContext(Dispatchers.IO) {
        existingId(s.ssid)?.let { wm().removeNetwork(it) }
        setOurs(ours() - s.ssid)
        storeCache(saved.value.filter { it.ssid != s.ssid })
        runCatching { s.vaultId?.let { Vault.remove(it) } }
        Sync.event("wifi", JSONObject().put("action", "forget").put("ssid", s.ssid))
    }

    // --- kasa ile eşitleme ---

    /**
     * Kasadaki Wi-Fi kayıtlarını al, telefonda kaydedilip kasaya henüz gitmemiş olanları gönder,
     * hepsini Android'e tanıt. Panelden silinen (Orbit'in eklediği) ağları kaldır.
     */
    fun syncVault(force: Boolean = false) {
        if (!::ctx.isInitialized || Store.creds == null) return
        val now = System.currentTimeMillis()
        if (!force && now - lastVaultSync < 5 * 60_000) return
        lastVaultSync = now
        var st = Vault.open()
        val local = saved.value
        if (st is Vault.State.None && local.any { it.vaultId == null }) st = Vault.State.Open(Vault.create())
        val key = (st as? Vault.State.Open)?.key ?: return
        val entries = Vault.list(key).filter { it.kind == "wifi" }
        val bySsid = entries.associateBy { it.app }
        // Telefonda eklenmiş, kasada olmayan
        for (s in local.filter { it.vaultId == null && it.ssid !in bySsid }) {
            Vault.save(key, Vault.Entry(null, s.ssid, "", s.password, "", "", kind = "wifi", security = s.security, hidden = s.hidden), null)
        }
        // Şifresi telefonda değişmiş
        for (s in local) {
            val e = bySsid[s.ssid] ?: continue
            if (e.password != s.password || e.security != s.security) Vault.save(key, e.copy(password = s.password, security = s.security, hidden = s.hidden), e)
        }
        val fresh = Vault.list(key).filter { it.kind == "wifi" }
        val list = fresh.map { Saved(it.id, it.app, it.password, it.security.ifBlank { "wpa" }, it.hidden) }
        // Panelden silinenler: kasada yok ama daha önce kasadan gelmişti
        val gone = local.filter { it.vaultId != null && fresh.none { f -> f.id == it.vaultId } }
        storeCache(list)
        ensureConfigured(gone.map { it.ssid })
    }

    private fun ensureConfigured(removed: List<String>) {
        val w = wm()
        val mine = ours()
        for (ssid in removed) if (ssid in mine) { existingId(ssid)?.let { w.removeNetwork(it) }; mine.remove(ssid) }
        setOurs(mine)
        for (s in saved.value) if (existingId(s.ssid) == null) runCatching { configure(s.ssid, s.password, s.security, s.hidden) }
        runCatching { if (!w.isWifiEnabled) w.isWifiEnabled = true }
    }

    // --- QR ---

    data class QrNet(val ssid: String, val password: String, val security: String, val hidden: Boolean)

    /** WIFI:T:WPA;S:ağ;P:şifre;H:true;; biçimi (\ ile kaçış) */
    fun parseQr(text: String): QrNet? {
        if (!text.startsWith("WIFI:", ignoreCase = true)) return null
        val fields = mutableMapOf<String, String>()
        var i = 5
        val body = text
        while (i < body.length) {
            val colon = body.indexOf(':', i).takeIf { it > 0 } ?: break
            val k = body.substring(i, colon).uppercase()
            val sb = StringBuilder()
            var j = colon + 1
            while (j < body.length) {
                val c = body[j]
                if (c == '\\' && j + 1 < body.length) { sb.append(body[j + 1]); j += 2; continue }
                if (c == ';') break
                sb.append(c); j++
            }
            fields[k] = sb.toString()
            i = j + 1
            if (i < body.length && body[i] == ';') break
        }
        val ssid = fields["S"]?.takeIf { it.isNotEmpty() } ?: return null
        val t = fields["T"]?.uppercase().orEmpty()
        val sec = when {
            t.contains("SAE") || t == "WPA3" -> "wpa3"
            t.startsWith("WPA") -> "wpa"
            t == "WEP" -> "wep"
            t == "NOPASS" || t.isEmpty() && fields["P"].isNullOrEmpty() -> "open"
            else -> "wpa"
        }
        return QrNet(ssid, fields["P"].orEmpty(), sec, fields["H"].equals("true", true))
    }
}
