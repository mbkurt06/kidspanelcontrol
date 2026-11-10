package app.orbit.device

import android.app.AppOpsManager
import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import android.os.UserManager
import android.provider.Telephony
import android.telecom.TelecomManager
import android.util.Log
import app.orbit.data.Store

class AdminReceiver : DeviceAdminReceiver()

/**
 * Cihaz sahibi (device owner) yetkileri: kaçış yollarını kapatır, uygulamaları askıya alır.
 * Uygulama device owner değilse hiçbir şey yapmaz; Orbit sadece süreyi sayar ve uyarı gösterir.
 */
object Policy {
    private const val TAG = "OrbitPolicy"

    fun admin(ctx: Context) = ComponentName(ctx, AdminReceiver::class.java)
    private fun dpm(ctx: Context) = ctx.getSystemService(DevicePolicyManager::class.java)

    fun isOwner(ctx: Context): Boolean = dpm(ctx).isDeviceOwnerApp(ctx.packageName)

    /**
     * maintenance = ebeveyn modu: kısıtlamalar (uygulama yükleme/yönetme, geliştirici seçenekleri) kalkar,
     * uygulamaların izin istekleri sorulmadan verilir. Süre bitince her şey geri gelir.
     */
    @Volatile private var lastMaintenance = false

    /**
     * Wi-Fi sadece Orbit'ten: telefonun kendi Wi-Fi ayarlarında ağ eklenemez/değiştirilemez (Wi-Fi açıp kapatmak serbest).
     * Panelde "telefonun Wi-Fi ayarlarını kullanabilir" açıksa ya da ebeveyn modunda kısıt kalkar.
     * Orbit telefon yöneticisi olduğu için kendi Wi-Fi ekranından bağlanmaya devam eder.
     */
    fun applyWifiLock(ctx: Context, maintenance: Boolean = lastMaintenance) {
        if (!isOwner(ctx)) return
        val free = maintenance || !PhoneSettings.wifiLocked()
        runCatching {
            if (free) dpm(ctx).clearUserRestriction(admin(ctx), UserManager.DISALLOW_CONFIG_WIFI)
            else dpm(ctx).addUserRestriction(admin(ctx), UserManager.DISALLOW_CONFIG_WIFI)
        }.onFailure { Log.w(TAG, "wifi kısıtı", it) }
    }

    fun applyBase(ctx: Context, maintenance: Boolean) {
        if (!isOwner(ctx)) return
        lastMaintenance = maintenance
        applyWifiLock(ctx, maintenance)
        val d = dpm(ctx)
        val a = admin(ctx)
        // Kısıtlamalar ve panelden yönetilen telefon ayarları (Telefon ayarları sekmesi)
        PhoneSettings.applyRestrictions(ctx, maintenance)
        runCatching {
            d.setPermissionPolicy(a, if (maintenance) DevicePolicyManager.PERMISSION_POLICY_AUTO_GRANT else DevicePolicyManager.PERMISSION_POLICY_PROMPT)
        }
        runCatching { d.setUninstallBlocked(a, ctx.packageName, true) }
        // Çocuk Orbit'i "durmaya zorla" veya "verileri sil" yapamasın
        if (Build.VERSION.SDK_INT >= 30) runCatching { d.setUserControlDisabledPackages(a, listOf(ctx.packageName)) }
        // Saat ağdan alınsın (panelde kapatılmadıysa) — PhoneSettings.applyRestrictions içinde
        if (Build.VERSION.SDK_INT < 30) @Suppress("DEPRECATION") runCatching { d.setAutoTimeRequired(a, true) }
        // Bildirim, kamera ve mikrofon (görev kanıtı) izinleri kendiliğinden verilsin
        val perms = mutableListOf("android.permission.CAMERA", "android.permission.RECORD_AUDIO")
        if (Build.VERSION.SDK_INT >= 31) perms += "android.permission.BLUETOOTH_CONNECT"
        if (Build.VERSION.SDK_INT >= 33) perms += listOf("android.permission.POST_NOTIFICATIONS", "android.permission.READ_MEDIA_AUDIO", "android.permission.READ_MEDIA_IMAGES")
        else perms += "android.permission.READ_EXTERNAL_STORAGE"
        for (perm in perms) runCatching {
            d.setPermissionGrantState(a, ctx.packageName, perm, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
        }
    }

    /**
     * Tam kilit (kiosk): Orbit ekrana kilitlenebilir; ana ekran tuşu ve yeniden başlatma sonrası da Orbit açılır.
     * Telefonun kendi kilit ekranı (PIN) ve güç menüsü çalışır; bildirim paneli ve diğer uygulamalar kapalı.
     */
    fun setKiosk(ctx: Context, on: Boolean, allowCalls: Boolean, extra: Collection<String> = emptyList()) {
        if (!isOwner(ctx)) return
        val d = dpm(ctx)
        val a = admin(ctx)
        val pkgs = mutableListOf(ctx.packageName)
        if (on) pkgs += extra
        if (on && allowCalls) {
            runCatching { ctx.getSystemService(TelecomManager::class.java).defaultDialerPackage }.getOrNull()?.let { pkgs += it }
            pkgs += listOf("com.android.server.telecom", "com.android.phone")
        }
        runCatching { d.setLockTaskPackages(a, pkgs.distinct().toTypedArray()) }.onFailure { Log.w(TAG, "kiosk paketleri", it) }
        runCatching {
            d.setLockTaskFeatures(
                a,
                DevicePolicyManager.LOCK_TASK_FEATURE_KEYGUARD or DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS or
                    DevicePolicyManager.LOCK_TASK_FEATURE_SYSTEM_INFO,
            )
        }
        val home = ComponentName(ctx, "app.orbit.ui.KioskHome")
        val pm = ctx.packageManager
        if (on) {
            runCatching { pm.setComponentEnabledSetting(home, android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED, android.content.pm.PackageManager.DONT_KILL_APP) }
            runCatching {
                val f = android.content.IntentFilter(Intent.ACTION_MAIN).apply {
                    addCategory(Intent.CATEGORY_HOME)
                    addCategory(Intent.CATEGORY_DEFAULT)
                }
                d.addPersistentPreferredActivity(a, f, home)
            }.onFailure { Log.w(TAG, "ana ekran", it) }
        } else {
            runCatching { d.clearPackagePersistentPreferredActivities(a, ctx.packageName) }
            runCatching { pm.setComponentEnabledSetting(home, android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED, android.content.pm.PackageManager.DONT_KILL_APP) }
        }
    }

    /** Kilit ekranında medya bildirimindeki oynat/duraklat gibi uzaktan kontrolleri kapatır. */
    fun setLockedMediaControls(ctx: Context, locked: Boolean) {
        if (!isOwner(ctx)) return
        val flags = if (locked) {
            DevicePolicyManager.KEYGUARD_DISABLE_SECURE_NOTIFICATIONS or
                DevicePolicyManager.KEYGUARD_DISABLE_REMOTE_INPUT
        } else 0
        runCatching { dpm(ctx).setKeyguardDisabledFeatures(admin(ctx), flags) }
            .onFailure { Log.w(TAG, "kilit ekranı medya kontrolleri", it) }
    }

    /** Orbit'e bir çalışma zamanı iznini ver (cihaz sahibiyse). */
    /** Wi-Fi taraması için konumu aç (Android 11+, telefon yöneticisi) */
    fun enableLocation(ctx: Context) {
        if (!isOwner(ctx) || android.os.Build.VERSION.SDK_INT < 30) return
        runCatching { dpm(ctx).setLocationEnabled(admin(ctx), true) }.onFailure { Log.w(TAG, "konum açılamadı", it) }
    }

    fun grantSelf(ctx: Context, perm: String) {
        if (!isOwner(ctx)) return
        runCatching { dpm(ctx).setPermissionGrantState(admin(ctx), ctx.packageName, perm, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED) }
    }

    private var lastBlockedMessage: String? = null

    /** Askıya alınmış uygulamaya dokununca çıkan sistem penceresindeki açıklama. Sadece değişince yazılır. */
    fun setBlockedMessage(ctx: Context, text: String) {
        if (!isOwner(ctx) || text == lastBlockedMessage) return
        runCatching {
            dpm(ctx).setShortSupportMessage(admin(ctx), text.take(200))
            dpm(ctx).setLongSupportMessage(admin(ctx), text)
            lastBlockedMessage = text
        }.onFailure { Log.w(TAG, "destek mesajı", it) }
    }

    /** Kullanım erişimi (hangi uygulamanın açık olduğunu görmek için) verilmiş mi? */
    fun hasUsageAccess(ctx: Context): Boolean {
        val ops = ctx.getSystemService(AppOpsManager::class.java)
        @Suppress("DEPRECATION")
        val mode = ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
        return mode == AppOpsManager.MODE_ALLOWED
    }

    /** Hiçbir zaman askıya alınmayacak paketler: Orbit, ana ekran, sistem arayüzü, telefon. */
    fun exempt(ctx: Context): Set<String> {
        val pm = ctx.packageManager
        val homes = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), 0)
            .map { it.activityInfo.packageName }
        val dialer = runCatching { ctx.getSystemService(TelecomManager::class.java).defaultDialerPackage }.getOrNull()
        return (homes + listOfNotNull(dialer) + listOf(
            ctx.packageName, "android", "com.android.systemui", "com.android.phone", "com.android.server.telecom",
            "com.miui.home", "com.android.emergency", "com.android.providers.downloads.ui",
            // Simgesi olmayan sistem ekranları: izin pencereleri, paket yükleyici, Xiaomi güvenlik/ayar ekranları.
            // Bunlar engellenirse Ayarlar'ın içindeki sayfalar ve izin soruları açılamaz.
            "com.android.permissioncontroller", "com.google.android.permissioncontroller",
            "com.android.packageinstaller", "com.google.android.packageinstaller", "com.miui.packageinstaller",
            "com.miui.securitycenter", "com.miui.securityadd", "com.xiaomi.misettings", "com.google.android.gms",
        )).toSet()
    }

    data class Launchable(val pkg: String, val label: String, val system: Boolean, val category: String? = null)

    fun launchables(ctx: Context): List<Launchable> {
        val pm = ctx.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        return pm.queryIntentActivities(intent, PackageManager.MATCH_ALL)
            .map {
                val ai = it.activityInfo.applicationInfo
                Launchable(
                    it.activityInfo.packageName, it.loadLabel(pm).toString(), (ai.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0,
                    categoryKey(ai.category),
                )
            }
            .filter { it.pkg != ctx.packageName }
            .distinctBy { it.pkg }
            .sortedBy { it.label.lowercase() }
    }

    private fun categoryKey(c: Int): String? = when (c) {
        android.content.pm.ApplicationInfo.CATEGORY_GAME -> "game"
        android.content.pm.ApplicationInfo.CATEGORY_AUDIO -> "audio"
        android.content.pm.ApplicationInfo.CATEGORY_VIDEO -> "video"
        android.content.pm.ApplicationInfo.CATEGORY_IMAGE -> "image"
        android.content.pm.ApplicationInfo.CATEGORY_SOCIAL -> "social"
        android.content.pm.ApplicationInfo.CATEGORY_NEWS -> "news"
        android.content.pm.ApplicationInfo.CATEGORY_MAPS -> "maps"
        android.content.pm.ApplicationInfo.CATEGORY_PRODUCTIVITY -> "productivity"
        else -> null
    }

    /** İlk eşleşmede telefon, rehber, mesaj, saat ve hesap makinesi "her zaman açık" ve onaylı gelir. */
    fun essentials(ctx: Context): Set<String> {
        val dialer = runCatching { ctx.getSystemService(TelecomManager::class.java).defaultDialerPackage }.getOrNull()
        val sms = runCatching { Telephony.Sms.getDefaultSmsPackage(ctx) }.getOrNull()
        val known = launchables(ctx).map { it.pkg }.filter { p ->
            listOf("contacts", "deskclock", "clock", "calculator", "dialer", ".mms", "messaging").any { p.contains(it) }
        }
        return (listOfNotNull(dialer, sms) + known).toSet()
    }

    /** Paketleri askıya alır / açar. Askıya alınamayanları döndürür. */
    fun setSuspended(ctx: Context, pkgs: Collection<String>, suspended: Boolean): List<String> {
        if (!isOwner(ctx) || pkgs.isEmpty()) return emptyList()
        return runCatching { dpm(ctx).setPackagesSuspended(admin(ctx), pkgs.toTypedArray(), suspended).toList() }
            .onFailure { Log.e(TAG, "askıya alma", it) }
            .getOrDefault(pkgs.toList())
    }

    /** Askıda olması gerekenleri uygular; sadece değişenler için sisteme gider. */
    fun syncSuspended(ctx: Context, shouldSuspend: Set<String>, full: Boolean = false, all: Collection<String> = emptyList()) {
        val prefs = Store.prefs()
        val current = prefs.getStringSet("suspended", emptySet())!!.toSet()
        val toSuspend = if (full) shouldSuspend else shouldSuspend - current
        val toRelease = if (full) (all.toSet() + current) - shouldSuspend else current - shouldSuspend
        val failed = setSuspended(ctx, toSuspend, true).toSet()
        setSuspended(ctx, toRelease, false)
        prefs.edit().putStringSet("suspended", (shouldSuspend - failed)).apply()
    }

    /**
     * Ana ekrana içerik veren uygulamalar (sola kaydırınca açılan haber akışı). Askıya alınsalar bile akış ana ekranda
     * görünmeye devam ettiği için, kapalı oldukları saatlerde tamamen gizlenirler; açık olduklarında geri gelirler.
     */
    val HIDE_WHEN_CLOSED = mapOf(
        "com.google.android.googlequicksearchbox" to "Google",
        "com.mi.globalminusscreen" to "App vault",
    )

    private fun installed(ctx: Context, pkg: String): Boolean = runCatching {
        @Suppress("DEPRECATION")
        ctx.packageManager.getApplicationInfo(pkg, PackageManager.MATCH_UNINSTALLED_PACKAGES); true
    }.getOrDefault(false)

    fun isHidden(ctx: Context, pkg: String): Boolean =
        isOwner(ctx) && runCatching { dpm(ctx).isApplicationHidden(admin(ctx), pkg) }.getOrDefault(false)

    /** Gizlenmiş ama yüklü olan akış uygulamaları (uygulama listesinde görünmezler, panele yine bildirilir). */
    fun hiddenFeedApps(ctx: Context): List<Launchable> =
        HIDE_WHEN_CLOSED.filter { (p, _) -> installed(ctx, p) && isHidden(ctx, p) }.map { (p, l) -> Launchable(p, l, true) }

    /** Akış uygulamalarını kurala göre gizle / göster. Sadece değişince işlem yapar. */
    fun syncHidden(ctx: Context, shouldHide: Map<String, Boolean>) {
        if (!isOwner(ctx)) return
        for ((pkg, hide) in shouldHide) {
            if (!installed(ctx, pkg)) continue
            if (isHidden(ctx, pkg) == hide) continue
            runCatching { dpm(ctx).setApplicationHidden(admin(ctx), pkg, hide) }.onFailure { Log.w(TAG, "gizleme $pkg", it) }
        }
    }

    /** Eşleşme kaldırılırsa veya Orbit devre dışı kalırsa her şeyi serbest bırak. */
    fun releaseAll(ctx: Context) {
        setSuspended(ctx, launchables(ctx).map { it.pkg }, false)
        syncHidden(ctx, HIDE_WHEN_CLOSED.keys.associateWith { false })
        Store.prefs().edit().remove("suspended").apply()
    }
}
