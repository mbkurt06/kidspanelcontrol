package app.orbit.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import app.orbit.R
import app.orbit.data.Store
import app.orbit.data.Sync
import app.orbit.device.Policy
import app.orbit.engine.AppVerdict
import app.orbit.engine.CommandType
import app.orbit.engine.DayUsage
import app.orbit.engine.RuleEngine
import app.orbit.engine.Snapshot
import app.orbit.ui.LockActivity
import app.orbit.ui.MainActivity
import app.orbit.update.Updater
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.ZonedDateTime

/** Ekranda gösterilecek anlık durum. */
data class LiveState(
    val snapshot: Snapshot? = null,
    val usage: DayUsage? = null,
    /** Şu an açılabilecek uygulamalar (paket → ad) */
    val allowedApps: List<Pair<String, String>> = emptyList(),
    val lockReason: String? = null,
    val online: Boolean = false,
    val lastSync: Long = 0,
)

object Live {
    private val _state = MutableStateFlow(LiveState())
    val state: StateFlow<LiveState> = _state.asStateFlow()
    fun set(s: LiveState) { _state.value = s }

    /** Ekrandan (ör. ekstra süre kullan) hemen yeniden hesaplama ve senkron istemek için. */
    @Volatile var syncRequested = false
}

/**
 * Orbit'in kalbi: ön planda sürekli çalışır.
 * - Her 2 saniyede ön plandaki uygulamayı bulur, süreyi sayar, kuralları uygular.
 * - Her 30 saniyede kuralları çeker, her 60 saniyede durumu gönderir.
 */
class OrbitService : Service() {
    companion object {
        private const val TAG = "OrbitService"
        private const val CH_RUN = "orbit_run"
        private const val CH_WARN = "orbit_warn"
        private const val TICK_MS = 2000L

        fun start(ctx: Context) {
            if (Store.creds == null) return
            val i = Intent(ctx, OrbitService::class.java)
            runCatching { ctx.startForegroundService(i) }.onFailure { Log.e(TAG, "servis başlatılamadı", it) }
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var loop: Job? = null
    private var foreground: String? = null
    private var lastEventTs = 0L
    private var lastTick = 0L
    private var lastPull = 0L
    private var lastPush = 0L
    private var firstRun = true
    private var lastParentMode = false
    @Volatile private var lastVault = 0L
    private val netBusy = java.util.concurrent.atomic.AtomicBoolean(false)
    private val pushBusy = java.util.concurrent.atomic.AtomicBoolean(false)
    private var lastLockLaunch = 0L
    private var lastLockPkg: String? = null

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            if (i.action == Intent.ACTION_SCREEN_ON || i.action == Intent.ACTION_USER_PRESENT) Live.syncRequested = true
        }
    }

    // Yeni uygulama yüklenince/kaldırılınca hemen bildir (yeni uygulama onaylanana kadar kapalı kalır)
    private val packageReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            if (i.getBooleanExtra(Intent.EXTRA_REPLACING, false)) return
            scope.launch(Dispatchers.IO) {
                Sync.reportApps(this@OrbitService, initial = false)
                Live.syncRequested = true
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Store.init(this)
        channels()
        val n = runningNotification("Orbit çalışıyor")
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(1, n)
        registerReceiver(screenReceiver, IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_USER_PRESENT)
        })
        registerReceiver(packageReceiver, IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED); addAction(Intent.ACTION_PACKAGE_FULLY_REMOVED); addDataScheme("package")
        })
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (loop?.isActive != true) loop = scope.launch { run() }
        return START_STICKY
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(screenReceiver) }
        runCatching { unregisterReceiver(packageReceiver) }
        scope.cancel()
        super.onDestroy()
    }

    private fun channels() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_RUN, "Orbit durumu", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        nm.createNotificationChannel(NotificationChannel(CH_WARN, "Süre uyarıları", NotificationManager.IMPORTANCE_HIGH))
    }

    private fun runningNotification(text: String): Notification {
        val pi = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CH_RUN)
            .setSmallIcon(R.drawable.ic_orbit)
            .setContentTitle("Orbit")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
    }

    private suspend fun run() {
        while (scope.isActive) {
            try {
                tick()
            } catch (e: Exception) {
                Log.e(TAG, "tick hatası", e)
            }
            delay(TICK_MS)
        }
    }

    private fun tick() {
        val nowMs = System.currentTimeMillis()
        val online = nowMs - Store.lastSync < 120_000
        if (Store.creds == null) { stopSelf(); return }

        // 1) Ağ işleri arka planda (internet yoksa sessizce geçer; kurallar telefonda kayıtlı)
        if ((firstRun || Live.syncRequested || nowMs - lastPull > 30_000) && netBusy.compareAndSet(false, true)) {
            lastPull = nowMs
            Live.syncRequested = false
            // İlk kez ya da yeni sürümde uygulama listesini (kategorilerle) yeniden bildir
            val report = !Store.prefs().getBoolean("appsReported", false) ||
                (firstRun && Store.prefs().getInt("appsReportedVersion", 0) != app.orbit.BuildConfig.VERSION_CODE)
            scope.launch(Dispatchers.IO) {
                try {
                    if (report) {
                        Sync.reportApps(this@OrbitService, initial = true)
                        Store.prefs().edit().putInt("appsReportedVersion", app.orbit.BuildConfig.VERSION_CODE).apply()
                    }
                    Sync.pullRules()
                    // Şifre kasası: sahip kaydı ve yeni ebeveyn cihazlarına anahtar paylaşımı (10 dk'da bir)
                    if (System.currentTimeMillis() - lastVault > 10 * 60_000L) {
                        lastVault = System.currentTimeMillis()
                        runCatching { app.orbit.data.Vault.open() }
                    }
                } finally {
                    netBusy.set(false)
                }
            }
        }

        val rules = Store.rules()
        val engine = RuleEngine(rules)
        val zone = engine.zone()
        val now = ZonedDateTime.now(zone)

        // 2) Gün değiştiyse sayaçları sıfırla (dünkü son durumu gönder)
        Store.rollover(now.toLocalDate())
        var usage = Store.usage(now.toLocalDate())

        // 3) Ön plandaki uygulama ve süre sayımı
        updateForeground(nowMs)
        val power = getSystemService(PowerManager::class.java)
        val interactive = power.isInteractive
        val dt = if (lastTick == 0L) 0L else ((nowMs - lastTick) / 1000).coerceIn(0, 10)
        lastTick = nowMs

        var snap = engine.snapshot(now, usage)
        val fg = foreground
        val exempt = Policy.exempt(this)
        if (interactive && fg != null && fg !in exempt) {
            val v = engine.verdict(fg, snap, usage)
            usage = engine.account(usage, fg, v, dt)
            snap = engine.snapshot(now, usage)
        }

        // 4) Uyarılar
        val warnings = engine.dueWarnings(snap, usage)
        if (warnings.isNotEmpty()) {
            warnings.forEach { (_, text) -> warn(text) }
            usage = usage.copy(warned = usage.warned + warnings.map { it.first })
        }
        Store.saveUsage(usage)

        // 5) Kuralları uygula: kapalı olması gerekenleri askıya al
        // Ebeveyn modu: bütün sınırlamalar kalkar (değiştiği anda hemen uygulanır)
        val maintenance = snap.parentMode
        if (firstRun || nowMs - lastPush > 60_000 || maintenance != lastParentMode) {
            lastParentMode = maintenance
            Policy.applyBase(this, maintenance)
            checkOwner()
        }
        val launchables = Policy.launchables(this)
        val allowed = mutableListOf<Pair<String, String>>()
        val suspend = mutableSetOf<String>()
        val verdicts = HashMap<String, AppVerdict>()
        for (a in launchables) {
            if (a.pkg in exempt) continue
            val v = engine.verdict(a.pkg, snap, usage)
            verdicts[a.pkg] = v
            if (v.allowed) allowed += a.pkg to a.label else suspend += a.pkg
        }
        Policy.syncSuspended(this, suspend, full = firstRun, all = launchables.map { it.pkg })

        // 6) Ön plandaki uygulama kapalıysa kilit ekranını göster
        var lockReason: String? = when {
            snap.parentMode -> null
            snap.locked -> "Telefon ebeveyn tarafından kilitlendi"
            snap.activeMode != null && snap.activeMode.othersBlocked -> "Şu an ${snap.activeMode.name}"
            snap.sectionMode && snap.section == null -> "Bu saatlerde kapalı"
            snap.sectionMode && snap.sectionClosed -> "Şu an ${snap.section!!.section.name}"
            snap.sectionMode && snap.remainingSeconds <= 0 -> "${snap.section!!.section.name} süren bitti"
            snap.remainingSeconds <= 0 -> "Günlük süren bitti"
            else -> null
        }
        if (interactive && fg != null && fg !in exempt) {
            val v = verdicts[fg] ?: engine.verdict(fg, snap, usage)
            if (!v.allowed) {
                lockReason = v.reason ?: lockReason
                showLock(v.reason ?: "Bu uygulama şu an kapalı", fg, nowMs)
            }
        }

        // 7) Kapalı uygulamaya dokununca çıkan sistem penceresinin ("Blocked by work policy") altındaki açıklama
        Policy.setBlockedMessage(this, blockedMessage(snap, rules.mandatoryOpen))

        Live.set(LiveState(snap, usage, allowed, lockReason, online, Store.lastSync))
        updateNotification(snap)

        // 7) Durum gönder
        if ((firstRun || nowMs - lastPush > 60_000) && pushBusy.compareAndSet(false, true)) {
            lastPush = nowMs
            val bat = battery()
            val reason = lockReason
            scope.launch(Dispatchers.IO) {
                try {
                    Sync.pushStatus(this@OrbitService, snap, usage, fg, reason, bat)
                    Store.previousUsage()?.let { prev ->
                        runCatching { Sync.pushUsage(prev) }.onSuccess { Store.savePreviousUsage(null) }
                    }
                } finally {
                    pushBusy.set(false)
                }
            }
        }
        if (nowMs - Store.lastUpdateCheck > 3600_000L) {
            Store.lastUpdateCheck = nowMs
            scope.launch(Dispatchers.IO) { Updater.check(this@OrbitService) }
        }
        firstRun = false
    }

    /** Kapalı uygulama penceresinde çocuğun göreceği açıklama (o anki duruma göre). */
    private fun blockedMessage(s: app.orbit.engine.Snapshot, mandatory: List<String>): String {
        val until = s.modeEndsAt?.toString()?.take(5)
        return when {
            s.parentMode -> "Orbit: Ebeveyn modu açık."
            s.locked -> "🔒 Telefon ebeveynin tarafından kilitlendi. Açılınca tekrar kullanabilirsin."
            s.activeMode != null && s.activeMode.othersBlocked ->
                "Şu an ${s.activeMode.name}" + (until?.let { " — $it'te biter." } ?: ".") + " Açık uygulamalar Orbit'te."
            mandatory.isNotEmpty() -> "Önce görevini yap: ${mandatory.first()}. Görev onaylanınca açılır."
            s.sectionMode && s.section == null -> "Şu an telefon kapalı saatlerde. Açık uygulamalar Orbit'te."
            s.sectionMode && s.section != null -> {
                val sec = s.section
                val end = sec.endsAt.toString().take(5)
                if (s.sectionClosed)
                    "Şu an ${sec.section.name} — telefon $end'e kadar kapalı. Açık uygulamalar Orbit'te."
                else if (s.remainingSeconds <= 0)
                    "⏰ ${sec.section.name} süren bitti (${sec.section.name} $end'te biter). Orbit'ten ebeveyninden süre isteyebilirsin."
                else
                    "Şu an ${sec.section.name} ($end'e kadar). Bu uygulama bu bölümde kapalı, süresi dolmuş ya da onay bekliyor. Açık uygulamalar Orbit'te."
            }
            s.remainingSeconds <= 0 -> "⏰ Bugünkü süren bitti. Yarın tekrar açılır; Orbit'ten ebeveyninden süre isteyebilirsin."
            else -> "Bu uygulama şu an kapalı: ebeveyn onayı bekliyor ya da bu saatlerde kapalı. Açık uygulamalar Orbit'te."
        }
    }

    /** Orbit yönetici yetkisini kaybederse ebeveyne bir kez haber ver. */
    private fun checkOwner() {
        val owner = Policy.isOwner(this)
        val prefs = Store.prefs()
        val was = prefs.getBoolean("wasOwner", false)
        if (owner && !was) prefs.edit().putBoolean("wasOwner", true).apply()
        if (!owner && was) {
            prefs.edit().putBoolean("wasOwner", false).apply()
            scope.launch(Dispatchers.IO) { Sync.event("device_owner_lost", org.json.JSONObject()) }
        }
    }

    private fun updateForeground(nowMs: Long) {
        if (!Policy.hasUsageAccess(this)) return
        val usm = getSystemService(UsageStatsManager::class.java)
        val from = if (lastEventTs == 0L) nowMs - 10 * 60_000L else lastEventTs - 1
        val events = usm.queryEvents(from, nowMs)
        val e = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(e)
            @Suppress("DEPRECATION")
            if (e.eventType == UsageEvents.Event.ACTIVITY_RESUMED || e.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                foreground = e.packageName
            }
            lastEventTs = maxOf(lastEventTs, e.timeStamp)
        }
    }

    private fun showLock(reason: String, pkg: String, nowMs: Long) {
        // Aynı uygulama için en fazla 1,5 sn'de bir aç
        if (pkg == lastLockPkg && nowMs - lastLockLaunch < 1500) return
        lastLockPkg = pkg
        lastLockLaunch = nowMs
        val i = Intent(this, LockActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("reason", reason).putExtra("pkg", pkg)
        runCatching { startActivity(i) }.onFailure { Log.e(TAG, "kilit ekranı açılamadı", it) }
    }

    private fun warn(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        val n = Notification.Builder(this, CH_WARN)
            .setSmallIcon(R.drawable.ic_orbit)
            .setContentTitle("Orbit")
            .setContentText(text)
            .setAutoCancel(true)
            .build()
        nm.notify(text.hashCode(), n)
    }

    private var lastNote = ""
    private fun updateNotification(s: Snapshot) {
        val rem = s.remainingSeconds / 60
        val text = buildString {
            if (s.remainingSeconds >= app.orbit.engine.UNLIMITED_SECONDS) append("Süre sınırı yok")
            else {
                append("Kalan süre: ")
                append(if (rem >= 60) "${rem / 60} sa ${rem % 60} dk" else "$rem dk")
            }
            s.activeMode?.let { append(" · ${it.name}") } ?: s.section?.let { append(" · ${it.section.name}") }
            if (s.locked) append(" · kilitli")
        }
        if (text == lastNote) return
        lastNote = text
        getSystemService(NotificationManager::class.java).notify(1, runningNotification(text))
    }

    private fun battery(): Int? = runCatching {
        getSystemService(BatteryManager::class.java).getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    }.getOrNull()
}
