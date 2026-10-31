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

    /** Kalıcı kısıtlamalar. Bakım modunda geliştirici seçenekleri geçici olarak açılır. */
    private val RESTRICTIONS = listOf(
        UserManager.DISALLOW_FACTORY_RESET,
        UserManager.DISALLOW_SAFE_BOOT,
        UserManager.DISALLOW_ADD_USER,
        UserManager.DISALLOW_REMOVE_USER,
        UserManager.DISALLOW_ADD_MANAGED_PROFILE,
        UserManager.DISALLOW_CONFIG_DATE_TIME,
        UserManager.DISALLOW_APPS_CONTROL,
        UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES,
        "no_install_unknown_sources_globally",
        "no_add_clone_profile",
    )

    /** Ebeveyn modunda bile kalan kısıtlamalar (yanlışlıkla sıfırlanıp Orbit'in yetkisi kaybolmasın). */
    private val ALWAYS = setOf(UserManager.DISALLOW_FACTORY_RESET)

    /**
     * maintenance = ebeveyn modu: kısıtlamalar (uygulama yükleme/yönetme, geliştirici seçenekleri) kalkar,
     * uygulamaların izin istekleri sorulmadan verilir. Süre bitince her şey geri gelir.
     */
    fun applyBase(ctx: Context, maintenance: Boolean) {
        if (!isOwner(ctx)) return
        val d = dpm(ctx)
        val a = admin(ctx)
        for (r in RESTRICTIONS) runCatching {
            if (maintenance && r !in ALWAYS) d.clearUserRestriction(a, r) else d.addUserRestriction(a, r)
        }.onFailure { Log.w(TAG, "kısıtlama $r", it) }
        runCatching {
            if (maintenance) d.clearUserRestriction(a, UserManager.DISALLOW_DEBUGGING_FEATURES)
            else d.addUserRestriction(a, UserManager.DISALLOW_DEBUGGING_FEATURES)
        }
        runCatching {
            d.setPermissionPolicy(a, if (maintenance) DevicePolicyManager.PERMISSION_POLICY_AUTO_GRANT else DevicePolicyManager.PERMISSION_POLICY_PROMPT)
        }
        runCatching { d.setUninstallBlocked(a, ctx.packageName, true) }
        // Çocuk Orbit'i "durmaya zorla" veya "verileri sil" yapamasın
        if (Build.VERSION.SDK_INT >= 30) runCatching { d.setUserControlDisabledPackages(a, listOf(ctx.packageName)) }
        // Saat her zaman ağdan alınsın (saati geri alarak süre kazanılamasın)
        if (Build.VERSION.SDK_INT >= 30) runCatching { d.setAutoTimeEnabled(a, true) }
        else @Suppress("DEPRECATION") runCatching { d.setAutoTimeRequired(a, true) }
        // Bildirim, kamera ve mikrofon (görev kanıtı) izinleri kendiliğinden verilsin
        val perms = mutableListOf("android.permission.CAMERA", "android.permission.RECORD_AUDIO")
        if (Build.VERSION.SDK_INT >= 33) perms += "android.permission.POST_NOTIFICATIONS"
        for (perm in perms) runCatching {
            d.setPermissionGrantState(a, ctx.packageName, perm, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
        }
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

    data class Launchable(val pkg: String, val label: String, val system: Boolean)

    fun launchables(ctx: Context): List<Launchable> {
        val pm = ctx.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        return pm.queryIntentActivities(intent, PackageManager.MATCH_ALL)
            .map {
                val ai = it.activityInfo.applicationInfo
                Launchable(it.activityInfo.packageName, it.loadLabel(pm).toString(), (ai.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0)
            }
            .filter { it.pkg != ctx.packageName }
            .distinctBy { it.pkg }
            .sortedBy { it.label.lowercase() }
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

    /** Eşleşme kaldırılırsa veya Orbit devre dışı kalırsa her şeyi serbest bırak. */
    fun releaseAll(ctx: Context) {
        setSuspended(ctx, launchables(ctx).map { it.pkg }, false)
        Store.prefs().edit().remove("suspended").apply()
    }
}
