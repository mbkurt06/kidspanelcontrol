package app.orbit.device

import android.app.NotificationManager
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.app.admin.SystemUpdatePolicy
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.media.AudioManager
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import android.os.UserManager
import android.provider.Settings
import android.util.Log
import app.orbit.data.Store
import app.orbit.data.Sync
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Panelden yönetilen telefon ayarları (Telefon ayarları sekmesi).
 * - Kısıtlamalar (ör. Bluetooth ayarları kilitli) her dakika uygulanır; ebeveyn modunda kalkar.
 * - Değerler (ses seviyesi, parlaklık, Wi-Fi açık…) sadece panelde değişince bir kez uygulanır; çocuk sonra değiştirebilir
 *   (ilgili kilit açık değilse).
 * - Tek seferlik işler (uygulama kaldır, veri temizle, yeniden başlat…) komutla gelir: [action].
 * Telefon güncel durumu panele bildirir ([report]).
 */
object PhoneSettings {
    private const val TAG = "OrbitPhoneSettings"
    private val bg = Executors.newSingleThreadExecutor()
    private val busy = AtomicBoolean(false)
    @Volatile private var errors = JSONObject()
    private var lastReport: String? = null
    private var lastReportAt = 0L

    private class Restr(val key: String, val name: String, val def: Boolean, val minSdk: Int = 28)

    /** Kısıtlamalar: panel anahtarı → Android kısıtı, varsayılan */
    private val RESTRS = listOf(
        Restr("lock_bt", UserManager.DISALLOW_CONFIG_BLUETOOTH, false),
        Restr("no_bt_share", UserManager.DISALLOW_BLUETOOTH_SHARING, false),
        Restr("lock_mobile", UserManager.DISALLOW_CONFIG_MOBILE_NETWORKS, false),
        Restr("no_roaming", UserManager.DISALLOW_DATA_ROAMING, false),
        Restr("no_tether", UserManager.DISALLOW_CONFIG_TETHERING, false),
        Restr("lock_airplane", UserManager.DISALLOW_AIRPLANE_MODE, false),
        Restr("lock_vpn", UserManager.DISALLOW_CONFIG_VPN, false),
        Restr("no_usb_file", UserManager.DISALLOW_USB_FILE_TRANSFER, false),
        Restr("no_install", UserManager.DISALLOW_INSTALL_APPS, false),
        Restr("no_uninstall", UserManager.DISALLOW_UNINSTALL_APPS, false),
        Restr("no_unknown", UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES, true),
        Restr("no_unknown", "no_install_unknown_sources_globally", true),
        Restr("no_apps_control", UserManager.DISALLOW_APPS_CONTROL, true),
        Restr("lock_volume", UserManager.DISALLOW_ADJUST_VOLUME, false),
        Restr("mic_off", UserManager.DISALLOW_UNMUTE_MICROPHONE, false),
        Restr("no_wallpaper", UserManager.DISALLOW_SET_WALLPAPER, false),
        Restr("lock_brightness", UserManager.DISALLOW_CONFIG_BRIGHTNESS, false),
        Restr("lock_timeout", UserManager.DISALLOW_CONFIG_SCREEN_TIMEOUT, false),
        Restr("lock_location", UserManager.DISALLOW_CONFIG_LOCATION, false),
        Restr("no_accounts", UserManager.DISALLOW_MODIFY_ACCOUNTS, false),
        Restr("lock_time", UserManager.DISALLOW_CONFIG_DATE_TIME, true),
        Restr("no_safe_boot", UserManager.DISALLOW_SAFE_BOOT, true),
        Restr("no_debug", UserManager.DISALLOW_DEBUGGING_FEATURES, true),
        Restr("no_add_user", UserManager.DISALLOW_ADD_USER, true),
        Restr("no_add_user", UserManager.DISALLOW_REMOVE_USER, true),
        Restr("no_add_user", UserManager.DISALLOW_ADD_MANAGED_PROFILE, true),
        Restr("no_add_user", "no_add_clone_profile", true),
        Restr("no_factory_reset", UserManager.DISALLOW_FACTORY_RESET, true),
    )
    /** Ebeveyn modunda bile kalanlar (Orbit'in yetkisi kaybolmasın) */
    private val ALWAYS = setOf(UserManager.DISALLOW_FACTORY_RESET)

    /** İzin grupları → Android izinleri */
    private val PERMS = mapOf(
        "camera" to listOf("android.permission.CAMERA"),
        "mic" to listOf("android.permission.RECORD_AUDIO"),
        "location" to listOf("android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_BACKGROUND_LOCATION"),
        "contacts" to listOf("android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"),
        "photos" to listOf("android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO", "android.permission.READ_EXTERNAL_STORAGE"),
        "phone" to listOf("android.permission.CALL_PHONE", "android.permission.READ_PHONE_STATE"),
        "sms" to listOf("android.permission.SEND_SMS", "android.permission.READ_SMS", "android.permission.RECEIVE_SMS"),
    )

    private fun dpm(ctx: Context) = ctx.getSystemService(DevicePolicyManager::class.java)

    /** Panelde istenen ayarlar (kurallarla birlikte gelir) */
    fun desired(): JSONObject = runCatching {
        JSONObject(Store.rulesJson ?: "{}").optJSONObject("device_settings") ?: JSONObject()
    }.getOrDefault(JSONObject())

    private fun list(o: JSONObject, k: String): Set<String> {
        val a = o.optJSONArray(k) ?: return emptySet()
        return (0 until a.length()).map { a.optString(it) }.filter { it.isNotBlank() }.toSet()
    }

    /** Panelden gizlenen uygulamalar (Orbit'in kendi gizlemesiyle birleşir) */
    fun hiddenSet(): Set<String> = list(desired(), "hidden")

    /** Wi-Fi ayarları kilidi: panelde seçilmediyse eski ayar (telefonun Wi-Fi ayarlarını kullanabilir) */
    fun wifiLocked(): Boolean {
        val d = desired()
        return if (d.has("lock_wifi")) d.optBoolean("lock_wifi") else !Store.prefs().getBoolean("systemWifi", false)
    }

    /** Kısıtlamaları uygula (Policy.applyBase her dakika çağırır) */
    fun applyRestrictions(ctx: Context, maintenance: Boolean) {
        val d = dpm(ctx)
        val a = Policy.admin(ctx)
        val want = desired()
        for (r in RESTRS) {
            if (Build.VERSION.SDK_INT < r.minSdk) continue
            val on = !maintenance && (if (want.has(r.key)) want.optBoolean(r.key) else r.def) || r.name in ALWAYS
            runCatching { if (on) d.addUserRestriction(a, r.name) else d.clearUserRestriction(a, r.name) }
                .onFailure { Log.w(TAG, "kısıt ${r.name}", it) }
        }
        // Her zaman uygulananlar (değer)
        runCatching { d.setCameraDisabled(a, !maintenance && want.optBoolean("camera_off")) }
        runCatching { d.setScreenCaptureDisabled(a, !maintenance && want.optBoolean("no_screenshot")) }
        var kg = 0
        if (want.optBoolean("kg_no_camera")) kg = kg or DevicePolicyManager.KEYGUARD_DISABLE_SECURE_CAMERA
        if (want.optBoolean("kg_no_notif")) kg = kg or DevicePolicyManager.KEYGUARD_DISABLE_SECURE_NOTIFICATIONS
        runCatching { d.setKeyguardDisabledFeatures(a, if (maintenance) 0 else kg) }
        if (Build.VERSION.SDK_INT >= 30) runCatching { d.setAutoTimeEnabled(a, if (want.has("auto_time")) want.optBoolean("auto_time") else true) }
        applyApps(ctx, want)
        // Değer ayarları değiştiyse arka planda bir kez uygula
        if (busy.compareAndSet(false, true)) bg.execute {
            try { applyValues(ctx, want) } catch (e: Throwable) { Log.w(TAG, "ayarlar", e) } finally { busy.set(false) }
        }
    }

    /** Uygulama kurulumu öncesi (Orbit'in kendi güncellemesi): yükleme kısıtını geçici kaldır */
    fun allowSelfInstall(ctx: Context) {
        runCatching { dpm(ctx).clearUserRestriction(Policy.admin(ctx), UserManager.DISALLOW_INSTALL_APPS) }
    }

    private fun applied(): JSONObject = runCatching { JSONObject(Store.prefs().getString("psApplied", "{}")!!) }.getOrDefault(JSONObject())

    private fun err(key: String, e: Throwable?) {
        val n = JSONObject(errors.toString())
        if (e == null) n.remove(key) else n.put(key, (e.message ?: e.javaClass.simpleName).take(120))
        errors = n
    }

    /** Değerler: panelde değişen her anahtar bir kez uygulanır */
    private fun applyValues(ctx: Context, want: JSONObject) {
        val done = applied()
        val keys = listOf("wifi_on", "bt_on", "location_on", "vol_media", "vol_ring", "vol_alarm", "vol_notif", "ringer", "dnd",
            "brightness", "brightness_auto", "timeout_sec", "stay_on", "private_dns", "update_policy", "perms")
        var changed = false
        for (k in keys) {
            if (!want.has(k)) continue
            // Panel aynı değeri tekrar seçerse de (çocuk arada değiştirdiyse) yeniden uygulansın diye değişim damgası
            val v = want.get(k).toString() + "@" + (want.optJSONObject("_rev")?.optString(k) ?: "")
            if (done.optString(k, "\u0000") == v) continue
            val r = runCatching { applyValue(ctx, k, want) }
            err(k, r.exceptionOrNull())
            // İzin gerektiren ayarlar (rahatsız etme) izin gelince tekrar denensin diye başarısızsa kaydetme
            if (r.isSuccess) { done.put(k, v); changed = true }
        }
        if (changed) Store.prefs().edit().putString("psApplied", done.toString()).apply()
    }

    private fun pct(p: Int, max: Int) = (p.coerceIn(0, 100) * max + 50) / 100

    private fun applyValue(ctx: Context, k: String, w: JSONObject) {
        val d = dpm(ctx)
        val a = Policy.admin(ctx)
        val am = ctx.getSystemService(AudioManager::class.java)
        when (k) {
            "wifi_on" -> {
                @Suppress("DEPRECATION")
                val ok = ctx.applicationContext.getSystemService(WifiManager::class.java).setWifiEnabled(w.optBoolean(k))
                if (!ok) throw IllegalStateException("Wi-Fi değiştirilemedi")
            }
            "bt_on" -> {
                val ad = ctx.getSystemService(BluetoothManager::class.java)?.adapter ?: throw IllegalStateException("Bluetooth yok")
                @Suppress("DEPRECATION", "MissingPermission")
                val ok = if (w.optBoolean(k)) ad.enable() else ad.disable()
                if (!ok) throw IllegalStateException("Bluetooth değiştirilemedi")
            }
            "location_on" -> {
                if (Build.VERSION.SDK_INT < 30) throw IllegalStateException("Android 11 gerekli")
                d.setLocationEnabled(a, w.optBoolean(k))
            }
            "vol_media" -> am.setStreamVolume(AudioManager.STREAM_MUSIC, pct(w.optInt(k), am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)), 0)
            "vol_ring" -> am.setStreamVolume(AudioManager.STREAM_RING, pct(w.optInt(k), am.getStreamMaxVolume(AudioManager.STREAM_RING)), 0)
            "vol_alarm" -> am.setStreamVolume(AudioManager.STREAM_ALARM, pct(w.optInt(k), am.getStreamMaxVolume(AudioManager.STREAM_ALARM)), 0)
            "vol_notif" -> am.setStreamVolume(AudioManager.STREAM_NOTIFICATION, pct(w.optInt(k), am.getStreamMaxVolume(AudioManager.STREAM_NOTIFICATION)), 0)
            "ringer" -> am.ringerMode = when (w.optString(k)) {
                "silent" -> AudioManager.RINGER_MODE_SILENT
                "vibrate" -> AudioManager.RINGER_MODE_VIBRATE
                else -> AudioManager.RINGER_MODE_NORMAL
            }
            "dnd" -> {
                val nm = ctx.getSystemService(NotificationManager::class.java)
                if (!nm.isNotificationPolicyAccessGranted) throw IllegalStateException("Rahatsız etme erişimi yok")
                nm.setInterruptionFilter(when (w.optString(k)) {
                    "priority" -> NotificationManager.INTERRUPTION_FILTER_PRIORITY
                    "alarms" -> NotificationManager.INTERRUPTION_FILTER_ALARMS
                    "total" -> NotificationManager.INTERRUPTION_FILTER_NONE
                    else -> NotificationManager.INTERRUPTION_FILTER_ALL
                })
            }
            "brightness" -> d.setSystemSetting(a, Settings.System.SCREEN_BRIGHTNESS, pct(w.optInt(k), 255).coerceAtLeast(1).toString())
            "brightness_auto" -> d.setSystemSetting(a, Settings.System.SCREEN_BRIGHTNESS_MODE, if (w.optBoolean(k)) "1" else "0")
            "timeout_sec" -> d.setSystemSetting(a, Settings.System.SCREEN_OFF_TIMEOUT, (w.optInt(k).coerceIn(15, 1800) * 1000).toString())
            "stay_on" -> d.setGlobalSetting(a, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, if (w.optBoolean(k)) "7" else "0")
            "private_dns" -> {
                if (Build.VERSION.SDK_INT < 29) throw IllegalStateException("Android 10 gerekli")
                val host = w.optString(k).trim()
                val r = if (host.isEmpty()) d.setGlobalPrivateDnsModeOpportunistic(a) else d.setGlobalPrivateDnsModeSpecifiedHost(a, host)
                if (r != DevicePolicyManager.PRIVATE_DNS_SET_NO_ERROR) throw IllegalStateException("DNS kurulamadı (kod $r)")
            }
            "update_policy" -> d.setSystemUpdatePolicy(a, when (w.optString(k)) {
                "auto" -> SystemUpdatePolicy.createAutomaticInstallPolicy()
                "night" -> SystemUpdatePolicy.createWindowedInstallPolicy(120, 300)
                "postpone" -> SystemUpdatePolicy.createPostponeInstallPolicy()
                else -> null
            })
            "perms" -> applyPerms(ctx, w.optJSONObject(k) ?: JSONObject())
        }
    }

    /** Uygulama izinleri: {paket: {grup: granted|denied|default}} */
    private fun applyPerms(ctx: Context, perms: JSONObject) {
        val d = dpm(ctx)
        val a = Policy.admin(ctx)
        for (pkg in perms.keys()) {
            if (pkg == ctx.packageName) continue
            val req = runCatching {
                ctx.packageManager.getPackageInfo(pkg, PackageManager.GET_PERMISSIONS).requestedPermissions?.toSet()
            }.getOrNull() ?: continue
            val groups = perms.optJSONObject(pkg) ?: continue
            for (g in groups.keys()) {
                val state = when (groups.optString(g)) {
                    "granted" -> DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED
                    "denied" -> DevicePolicyManager.PERMISSION_GRANT_STATE_DENIED
                    else -> DevicePolicyManager.PERMISSION_GRANT_STATE_DEFAULT
                }
                for (p in PERMS[g].orEmpty()) if (p in req) runCatching { d.setPermissionGrantState(a, pkg, p, state) }
            }
        }
    }

    /** Gizli, kaldırılamaz ve tekrar yüklenemez uygulamalar */
    private fun applyApps(ctx: Context, want: JSONObject) {
        val d = dpm(ctx)
        val a = Policy.admin(ctx)
        val p = Store.prefs()
        val hidden = list(want, "hidden") - ctx.packageName
        val prevHidden = p.getStringSet("psHidden", emptySet())!!
        for (pkg in hidden) runCatching { if (!d.isApplicationHidden(a, pkg)) d.setApplicationHidden(a, pkg, true) }
        for (pkg in prevHidden - hidden) {
            if (pkg in Policy.HIDE_WHEN_CLOSED.keys) continue // akış uygulamalarını kural yönetir
            runCatching { d.setApplicationHidden(a, pkg, false) }
        }
        val blocked = list(want, "uninstall_blocked") - ctx.packageName
        val prevBlocked = p.getStringSet("psBlocked", emptySet())!!
        for (pkg in blocked) runCatching { d.setUninstallBlocked(a, pkg, true) }
        for (pkg in prevBlocked - blocked) runCatching { d.setUninstallBlocked(a, pkg, false) }
        p.edit().putStringSet("psHidden", hidden).putStringSet("psBlocked", blocked).apply()
        // Tekrar yüklenmesi engellenen uygulama kurulduysa kaldır (5 dk'da bir denenir)
        val noReinstall = list(want, "no_reinstall")
        val now = System.currentTimeMillis()
        for (pkg in noReinstall) {
            if (!installed(ctx, pkg)) continue
            val key = "psReinstall:$pkg"
            if (now - p.getLong(key, 0L) < 5 * 60_000L) continue
            p.edit().putLong(key, now).apply()
            uninstall(ctx, pkg, "Tekrar yüklenmesi engelli")
        }
    }

    fun installed(ctx: Context, pkg: String): Boolean = runCatching {
        ctx.packageManager.getApplicationInfo(pkg, PackageManager.MATCH_UNINSTALLED_PACKAGES or PackageManager.MATCH_DISABLED_COMPONENTS)
        true
    }.getOrDefault(false)

    private fun isSystem(ctx: Context, pkg: String): Boolean = runCatching {
        (ctx.packageManager.getApplicationInfo(pkg, 0).flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0
    }.getOrDefault(false)

    /** Panelden gizlenmiş ama yüklü uygulamalar (listede görünmezler; panele yine bildirilir) */
    fun hiddenApps(ctx: Context): List<Policy.Launchable> = Store.prefs().getStringSet("psHidden", emptySet())!!.mapNotNull { pkg ->
        runCatching {
            val ai = ctx.packageManager.getApplicationInfo(pkg, PackageManager.MATCH_UNINSTALLED_PACKAGES)
            Policy.Launchable(pkg, ai.loadLabel(ctx.packageManager).toString(), (ai.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0)
        }.getOrNull()
    }

    /** Yeni kurulan uygulama "tekrar yüklenemesin" listesindeyse hemen kaldır */
    fun onPackageAdded(ctx: Context, pkg: String) {
        if (pkg in list(desired(), "no_reinstall")) uninstall(ctx, pkg, "Tekrar yüklenmesi engelli")
    }

    /** Sessiz kaldırma (telefon yöneticisi). Sonuç [ActionReceiver]'a gelir ve olaylara yazılır. */
    fun uninstall(ctx: Context, pkg: String, why: String? = null) {
        if (pkg == ctx.packageName) return
        val i = Intent(ctx, ActionReceiver::class.java).putExtra("pkg", pkg).putExtra("why", why)
        val pi = PendingIntent.getBroadcast(ctx, pkg.hashCode(), i, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        runCatching {
            // Kaldırma kilidi varsa önce aç
            runCatching { dpm(ctx).setUninstallBlocked(Policy.admin(ctx), pkg, false) }
            ctx.packageManager.packageInstaller.uninstall(pkg, pi.intentSender)
        }.onFailure {
            Thread { Sync.event("phone_action", JSONObject().put("action", "uninstall").put("package", pkg).put("ok", false).put("error", it.message ?: "hata")) }.start()
        }
    }

    /** Panelden gelen tek seferlik iş */
    fun action(ctx: Context, a: JSONObject) {
        val act = a.optString("action")
        val pkg = a.optString("package").takeIf { it.isNotBlank() }
        val d = dpm(ctx)
        val adm = Policy.admin(ctx)
        fun done(ok: Boolean, error: String? = null) {
            Thread {
                Sync.event("phone_action", JSONObject().put("action", act).put("package", pkg ?: JSONObject.NULL).put("ok", ok).put("error", error ?: JSONObject.NULL))
                lastReport = null
            }.start()
        }
        when (act) {
            "uninstall" -> if (pkg != null) {
                if (isSystem(ctx, pkg)) done(false, "Sistem uygulaması kaldırılamaz, gizlenebilir") else uninstall(ctx, pkg)
            }
            "clear_data" -> if (pkg != null && Build.VERSION.SDK_INT >= 28) runCatching {
                d.clearApplicationUserData(adm, pkg, bg) { _, ok -> done(ok, if (ok) null else "Veri temizlenemedi") }
            }.onFailure { done(false, it.message) }
            "reboot" -> runCatching { d.reboot(adm) }.onFailure { done(false, it.message) }
            "lock_now" -> runCatching { d.lockNow(); done(true) }.onFailure { done(false, it.message) }
            "ask_dnd" -> runCatching {
                ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                done(true)
            }.onFailure { done(false, it.message) }
            "ask_power" -> runCatching {
                ctx.startActivity(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, android.net.Uri.parse("package:${ctx.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
                done(true)
            }.onFailure { done(false, it.message) }
            "reapply" -> { Store.prefs().edit().remove("psApplied").apply(); lastReport = null; done(true) }
        }
    }

    /** Güncel durum (panelde gösterilir) */
    fun state(ctx: Context): JSONObject {
        val o = JSONObject()
        val d = dpm(ctx)
        val a = Policy.admin(ctx)
        val am = ctx.getSystemService(AudioManager::class.java)
        fun vol(s: Int) = runCatching { (am.getStreamVolume(s) * 100 + am.getStreamMaxVolume(s) / 2) / am.getStreamMaxVolume(s).coerceAtLeast(1) }.getOrNull()
        runCatching { @Suppress("DEPRECATION") o.put("wifi_on", ctx.applicationContext.getSystemService(WifiManager::class.java).isWifiEnabled) }
        runCatching { @Suppress("MissingPermission") o.put("bt_on", ctx.getSystemService(BluetoothManager::class.java)?.adapter?.isEnabled == true) }
        runCatching { o.put("location_on", ctx.getSystemService(LocationManager::class.java).isLocationEnabled) }
        vol(AudioManager.STREAM_MUSIC)?.let { o.put("vol_media", it) }
        vol(AudioManager.STREAM_RING)?.let { o.put("vol_ring", it) }
        vol(AudioManager.STREAM_ALARM)?.let { o.put("vol_alarm", it) }
        vol(AudioManager.STREAM_NOTIFICATION)?.let { o.put("vol_notif", it) }
        o.put("ringer", when (am.ringerMode) { AudioManager.RINGER_MODE_SILENT -> "silent"; AudioManager.RINGER_MODE_VIBRATE -> "vibrate"; else -> "normal" })
        val nm = ctx.getSystemService(NotificationManager::class.java)
        o.put("dnd_access", nm.isNotificationPolicyAccessGranted)
        o.put("dnd", when (nm.currentInterruptionFilter) {
            NotificationManager.INTERRUPTION_FILTER_PRIORITY -> "priority"
            NotificationManager.INTERRUPTION_FILTER_ALARMS -> "alarms"
            NotificationManager.INTERRUPTION_FILTER_NONE -> "total"
            else -> "off"
        })
        val cr = ctx.contentResolver
        runCatching { o.put("brightness", (Settings.System.getInt(cr, Settings.System.SCREEN_BRIGHTNESS) * 100 + 127) / 255) }
        runCatching { o.put("brightness_auto", Settings.System.getInt(cr, Settings.System.SCREEN_BRIGHTNESS_MODE) == 1) }
        runCatching { o.put("timeout_sec", Settings.System.getInt(cr, Settings.System.SCREEN_OFF_TIMEOUT) / 1000) }
        runCatching { o.put("stay_on", Settings.Global.getInt(cr, Settings.Global.STAY_ON_WHILE_PLUGGED_IN) != 0) }
        if (Build.VERSION.SDK_INT >= 29) runCatching { o.put("private_dns", if (d.getGlobalPrivateDnsMode(a) == DevicePolicyManager.PRIVATE_DNS_MODE_PROVIDER_HOSTNAME) d.getGlobalPrivateDnsHost(a) ?: "" else "") }
        runCatching { o.put("auto_time", Settings.Global.getInt(cr, Settings.Global.AUTO_TIME) == 1) }
        runCatching { o.put("camera_off", d.getCameraDisabled(a)) }
        runCatching { o.put("no_screenshot", d.getScreenCaptureDisabled(a)) }
        val um = ctx.getSystemService(UserManager::class.java)
        val rs = JSONObject()
        runCatching {
            val b = d.getUserRestrictions(a)
            for (r in RESTRS) if (!rs.optBoolean(r.key)) rs.put(r.key, b.getBoolean(r.name))
            rs.put("lock_wifi", b.getBoolean(UserManager.DISALLOW_CONFIG_WIFI))
        }.onFailure { for (r in RESTRS) if (!rs.optBoolean(r.key)) rs.put(r.key, um.hasUserRestriction(r.name)) }
        o.put("restrictions", rs)
        o.put("hidden", JSONArray(Store.prefs().getStringSet("psHidden", emptySet())!!.sorted()))
        o.put("uninstall_blocked", JSONArray(Store.prefs().getStringSet("psBlocked", emptySet())!!.sorted()))
        o.put("owner", Policy.isOwner(ctx))
        o.put("power_exempt", ctx.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(ctx.packageName))
        runCatching {
            val bm = ctx.getSystemService(BatteryManager::class.java)
            o.put("battery", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
            o.put("charging", bm.isCharging)
        }
        runCatching {
            val st = StatFs(Environment.getDataDirectory().path)
            o.put("storage_free_mb", st.availableBytes / 1_048_576).put("storage_total_mb", st.totalBytes / 1_048_576)
        }
        o.put("android", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT).put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
        o.put("errors", errors)
        runCatching { o.put("rec_upload", app.orbit.data.Recorder.uploadState()) }
        return o
    }

    /** Durum değiştiyse (ya da 10 dk geçtiyse) panele bildir */
    fun report(ctx: Context) {
        runCatching {
            val s = state(ctx)
            // Pil yüzdesi her dakika değişmesin diye 5'lik
            s.optInt("battery", -1).takeIf { it >= 0 }?.let { s.put("battery", it / 5 * 5) }
            s.optLong("storage_free_mb", -1).takeIf { it >= 0 }?.let { s.put("storage_free_mb", it / 100 * 100) }
            val key = s.toString()
            val now = System.currentTimeMillis()
            if (key == lastReport && now - lastReportAt < 10 * 60_000L) return
            app.orbit.data.Api.rpc("device_report_settings", JSONObject().put("p_reported", s))
            lastReport = key
            lastReportAt = now
        }.onFailure { Log.w(TAG, "bildirilemedi", it) }
    }

    /** Ayar değiştirilince durumu hemen yeniden bildir */
    fun reportSoon() { lastReport = null }
}

/** Uygulama kaldırma sonucu */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Store.init(context)
        val st = intent.getIntExtra(android.content.pm.PackageInstaller.EXTRA_STATUS, -99)
        val pkg = intent.getStringExtra("pkg")
        val why = intent.getStringExtra("why")
        val msg = intent.getStringExtra(android.content.pm.PackageInstaller.EXTRA_STATUS_MESSAGE)
        if (st == android.content.pm.PackageInstaller.STATUS_PENDING_USER_ACTION) return
        val ok = st == android.content.pm.PackageInstaller.STATUS_SUCCESS
        Thread {
            Sync.event("phone_action", JSONObject().put("action", "uninstall").put("package", pkg).put("ok", ok)
                .put("error", if (ok) JSONObject.NULL else msg ?: "kod $st").put("why", why ?: JSONObject.NULL))
            if (ok) runCatching { Sync.reportApps(context, initial = false) }
            app.orbit.service.Live.syncRequested = true
        }.start()
        PhoneSettings.reportSoon()
    }
}
