package app.orbit.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
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
import app.orbit.BuildConfig
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
    /** Tam kilit (kiosk) sürüyorsa */
    val kiosk: app.orbit.engine.KioskNow? = null,
    /** Ebeveyn PIN'i ile açıldıysa bitiş (ms) */
    val pinUntil: Long? = null,
    /** Ekran yakalama sürerken kilit yumuşar: ekran sabitleme kalkar, yalnızca Orbit + görevin izinli uygulamaları açık */
    val kioskSoft: Boolean = false,
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
    @Volatile private var lastPush = 0L
    private var firstRun = true
    private var lastParentMode = false
    private var lastRemind = 0L
    @Volatile private var lastVault = 0L
    private val netBusy = java.util.concurrent.atomic.AtomicBoolean(false)
    private val recBusy = java.util.concurrent.atomic.AtomicBoolean(false)
    private var lastRecPump = 0L
    private var lastRecFront = 0L
    private var lastKioskFront = 0L
    private var lastKioskKey: String? = null
    private var mediaFocus: AudioFocusRequest? = null
    private var lastMediaLocked: Boolean? = null
    private val pushBusy = java.util.concurrent.atomic.AtomicBoolean(false)
    private val surplusBusy = java.util.concurrent.atomic.AtomicBoolean(false)
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
        app.orbit.data.Notifier.init(this)
        app.orbit.data.Alarms.init(this)
        AlarmReceiver.channels(this)
        scope.launch(Dispatchers.IO) { runCatching { app.orbit.data.Alarms.reschedule(force = true) } }
        // Panelden gelen değişiklikleri anında almak için canlı bağlantı
        app.orbit.data.Realtime.start()
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
        mediaFocus?.let { runCatching { getSystemService(AudioManager::class.java).abandonAudioFocusRequest(it) } }
        if (lastMediaLocked == true) Policy.setLockedMediaControls(this, false)
        runCatching { unregisterReceiver(screenReceiver) }
        runCatching { unregisterReceiver(packageReceiver) }
        app.orbit.data.Realtime.stop()
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

        if (Store.installedVersion != BuildConfig.VERSION_CODE) {
            Store.installedVersion = BuildConfig.VERSION_CODE
            if (Store.lastUpdateAt == 0L) Store.lastUpdateAt = nowMs
            scope.launch(Dispatchers.IO) { Sync.pushUpdateStatus("Güncel (${BuildConfig.VERSION_CODE})", BuildConfig.VERSION_CODE) }
        }

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
                    val before = Store.rulesJson
                    Sync.pullRules()
                    // Kurallar değiştiyse (ör. ebeveyn süre verdi) durumu hemen gönder: panel halkası güncellensin
                    if (Store.rulesJson != before) lastPush = 0L
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

        // Kameralı görev kaydı sürerken telefon sadece kayıt ekranına (ve her zaman açık olanlara) açık
        val rec = app.orbit.data.Recorder.current()
        val baseRules = Store.rules()
        // Görev oturumu (ekran kaydı ya da "Göreve başla"): sadece Orbit + görevin izinli uygulamaları, süre sayılmaz
        val session = app.orbit.data.TaskSession.current()?.let { s ->
            val open = app.orbit.data.Tasks.current().any { it.runId == s.runId && it.status in setOf("open", "started", "rejected") }
            val stale = s.screen && !ScreenCaptureService.active(nowMs)
            if (open && !stale) s else { app.orbit.data.TaskSession.stop(s.runId); null }
        }
        val rules = when {
            rec?.status == "recording" -> baseRules.copy(focus = app.orbit.engine.Focus("Kamera kaydı", emptySet(), emptySet()))
            session != null -> baseRules.copy(focus = app.orbit.engine.Focus("Görev: ${session.title}", emptySet(), session.packages))
            else -> baseRules
        }
        recordingTick(rec, nowMs)
        val engine = RuleEngine(rules)
        engine.sessionPackages = session?.packages.orEmpty()
        val zone = engine.zone()
        val now = ZonedDateTime.now(zone)

        // 2) Gün değiştiyse kalan hakkı kasaya ayır, sonra sayaçları sıfırla.
        val rolled = Store.rollover(now.toLocalDate())
        if (rolled != null) {
            val oldEngine = RuleEngine(rules)
            val surplus = oldEngine.surplusMinutes(rolled.day, rolled)
            Store.addPendingSurplus(rolled.day, surplus)
        }
        if (surplusBusy.compareAndSet(false, true)) {
            val pending = Store.pendingSurpluses().entries.firstOrNull()
            if (pending == null) surplusBusy.set(false)
            else scope.launch(Dispatchers.IO) {
                try {
                    if (Sync.storeDailySurplus(pending.key, pending.value)) Store.clearPendingSurplus(pending.key)
                } finally {
                    surplusBusy.set(false)
                }
            }
        }
        var usage = Store.usage(now.toLocalDate())
        engine.refreshSpent(usage, now.toLocalDate())
        // Kullanılmayan saat aralıklı süreyi kasaya aktar (dakikada bir)
        if (nowMs - lastLeftover > 60_000) {
            lastLeftover = nowMs
            leftoverTick(engine, usage, now)
        }

        // 3) Ön plandaki uygulama ve süre sayımı
        updateForeground(nowMs)
        val power = getSystemService(PowerManager::class.java)
        val interactive = power.isInteractive
        val dt = if (lastTick == 0L) 0L else ((nowMs - lastTick) / 1000).coerceIn(0, 10)
        lastTick = nowMs

        var snap = engine.snapshot(now, usage)
        val fg = foreground
        // Sayaç odak profili aramalara izin vermiyorsa telefon uygulaması da kapanır (acil arama hariç)
        val focusProfile = app.orbit.data.Timers.activeFocus()
        val dialer = if (focusProfile != null && !focusProfile.callsAllowed)
            runCatching { getSystemService(android.telecom.TelecomManager::class.java).defaultDialerPackage }.getOrNull() else null
        val exempt = if (dialer != null) Policy.exempt(this) - dialer else Policy.exempt(this)
        if (interactive && fg != null && fg !in exempt) {
            val v0 = engine.verdict(fg, snap, usage)
            val v = if (session != null) v0.copy(countsDaily = false, countsMode = null, buckets = emptyList()) else v0
            usage = engine.account(usage, fg, v, dt)
            snap = engine.snapshot(now, usage)
        }

        // Sayaç: odaklı/uzak süre, geri sayım bitişi, mola sınırı
        timerTick(engine, snap, usage, fg, exempt, interactive, dt, nowMs)

        // Saatli görev hatırlatması (dakikada bir)
        if (nowMs - lastRemind > 60_000) {
            lastRemind = nowMs
            runCatching { app.orbit.data.TaskAlerts.remind(app.orbit.data.Tasks.current(), now.toLocalDate(), now.toLocalTime()) }
        }

        // 4) Uyarılar
        val warnings = engine.dueWarnings(snap, usage)
        if (warnings.isNotEmpty()) {
            warnings.forEach { (_, text) -> warn(text) }
            usage = usage.copy(warned = usage.warned + warnings.map { it.first })
        }
        Store.saveUsage(usage)

        // PIN ile ebeveyn modu (telefonda ebeveyn PIN'i girildi)
        val pinUntil = app.orbit.data.Kiosk.pinUntil()
        if (pinUntil != null && !snap.parentMode) snap = snap.copy(parentMode = true, parentModeUntil = pinUntil)
        // Tam kilit (kiosk)
        val kiosk = if (snap.parentMode) null else runCatching { app.orbit.engine.Extras.kiosk(rules, engine, now) }.getOrNull()
        val mediaLocked = snap.locked || kiosk != null
        if (mediaLocked) {
            if (mediaFocus == null) {
                mediaFocus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                    .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).build())
                    .setOnAudioFocusChangeListener { }
                    .build()
            }
            runCatching { getSystemService(AudioManager::class.java).requestAudioFocus(mediaFocus!!) }
        } else {
            mediaFocus?.let { runCatching { getSystemService(AudioManager::class.java).abandonAudioFocusRequest(it) } }
            mediaFocus = null
        }
        if (lastMediaLocked != mediaLocked) {
            lastMediaLocked = mediaLocked
            Policy.setLockedMediaControls(this, mediaLocked)
        }
        val captureOn = ScreenCaptureService.active(nowMs) || session != null
        val kioskKey = if (kiosk != null) "on:$captureOn:${rules.kiosk.calls}:${rules.taskAllowedPackages.sorted().joinToString(",")}" else "off"
        if (kioskKey != lastKioskKey) {
            lastKioskKey = kioskKey
            Policy.setKiosk(this, kiosk != null, rules.kiosk.calls == "all", rules.taskAllowedPackages)
        }
        // Müzik: kurallar kapattıysa durdur
        app.orbit.data.Music.blocked.value = runCatching { app.orbit.engine.Extras.musicBlocked(rules, engine, now) }.getOrNull()
        app.orbit.data.Music.enforce()

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
        // Ana ekran haber akışı (Google vb.): kapalıyken gizle, açıkken göster — normal uygulama kuralıyla
        Policy.syncHidden(this, Policy.HIDE_WHEN_CLOSED.keys.associateWith { p -> !(verdicts[p] ?: engine.verdict(p, snap, usage)).allowed })

        // 6) Ön plandaki uygulama kapalıysa kilit ekranını göster
        var lockReason: String? = when {
            snap.parentMode -> null
            snap.locked -> snap.limitName?.let { "Sınırlı · $it" } ?: "Sınırlı"
            snap.activeMode != null && snap.activeMode.othersBlocked -> "Şu an ${snap.activeMode.name}"
            snap.sectionMode && snap.section == null -> "Bu saatlerde kapalı"
            snap.sectionMode && snap.sectionClosed -> "Şu an ${snap.section!!.section.name}"
            snap.sectionMode && snap.remainingSeconds <= 0 -> "${snap.section!!.section.name} süren bitti"
            snap.remainingSeconds <= 0 -> "Günlük süren bitti"
            else -> null
        }
        if (kiosk != null) {
            lockReason = "🔒 ${kiosk.name}"
            val ok = mutableSetOf(packageName, "android", "com.android.systemui", "com.android.phone", "com.android.emergency", "com.android.server.telecom")
            ok += engine.raNow.keys.filter { engine.restrictedLeft(it, usage) }
            session?.let { ok += it.packages }
            if (captureOn) ok += listOf("com.android.permissioncontroller", "com.google.android.permissioncontroller")
            if (rules.kiosk.calls == "all") runCatching { getSystemService(android.telecom.TelecomManager::class.java).defaultDialerPackage }.getOrNull()?.let { ok += it }
            if (interactive && fg != null && fg !in ok && nowMs - lastKioskFront > 2_000) {
                lastKioskFront = nowMs
                runCatching {
                    startActivity(Intent(this, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
                }
            }
        } else if (session != null && interactive && fg != null && fg !in session.packages && fg != packageName &&
            fg !in setOf("android", "com.android.systemui", "com.android.phone", "com.android.server.telecom", "com.android.permissioncontroller", "com.google.android.permissioncontroller") &&
            fg != runCatching { getSystemService(android.telecom.TelecomManager::class.java).defaultDialerPackage }.getOrNull()) {
            // Görev sürerken başka uygulamaya geçilemez: Orbit'e dön (orada duraklat / bitir)
            lockReason = "Görev sürüyor: ${session.title}"
            if (nowMs - lastRecFront > 2_000) {
                lastRecFront = nowMs
                runCatching {
                    startActivity(Intent(this, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
                }
            }
        } else if (rec?.status == "recording" && interactive && fg != null && fg !in exempt && fg != packageName) {
            // Kayıt sürerken başka uygulamaya geçilirse kayıt ekranına dön
            if (nowMs - lastRecFront > 3_000) {
                lastRecFront = nowMs
                runCatching {
                    startActivity(Intent(this, app.orbit.ui.RecordActivity::class.java)
                        .putExtra("runId", rec.runId)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
                }
            }
        } else if (interactive && fg != null && fg !in exempt) {
            val v = verdicts[fg] ?: engine.verdict(fg, snap, usage)
            if (!v.allowed) {
                lockReason = v.reason ?: lockReason
                showLock(v.reason ?: "Bu uygulama şu an kapalı", fg, nowMs)
            }
        }

        // 7) Kapalı uygulamaya dokununca çıkan sistem penceresinin ("Blocked by work policy") altındaki açıklama
        Policy.setBlockedMessage(this, blockedMessage(snap, rules.mandatoryOpen))

        Live.set(LiveState(snap, usage, allowed, lockReason, online, Store.lastSync, kiosk, pinUntil, kiosk != null && captureOn))
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
        // 1 dk yoklama; canlı bağlantı kopsa bile yeni APK kısa sürede otomatik alınır.
        if (nowMs - Store.lastUpdateCheck > 60_000L) {
            Store.lastUpdateCheck = nowMs
            val checkOnly = Store.updateCheckOnly
            Store.updateCheckOnly = false
            scope.launch(Dispatchers.IO) { Updater.check(this@OrbitService, installIfNew = !checkOnly) }
        }
        firstRun = false
    }

    /** Kayıt: servis beklenmedik kapandıysa molaya al ve bildir; bekleyen parçaları yükle. */
    private var lastLeftover = 0L

    /**
     * Saat aralıklı süre bittiğinde kullanılmayan kısmı bildir: sunucu devam kaydına ya da kasaya aktarır.
     * Gün değişince sayaçlar sıfırlandığı için son kullanım dakikada bir saklanır.
     */
    private fun leftoverTick(engine: RuleEngine, usage: app.orbit.engine.DayUsage, now: ZonedDateTime) {
        val day = now.toLocalDate()
        val t = now.toLocalTime()
        val prefs = Store.prefs()
        val used = runCatching { org.json.JSONObject(prefs.getString("grantUsed", "{}")) }.getOrDefault(org.json.JSONObject())
        val done = prefs.getStringSet("grantLeftDone", emptySet()).orEmpty().toMutableSet()
        val due = mutableListOf<Pair<String, Int>>()
        for (g in Store.rules().grants) {
            val w = g.window ?: continue
            if (!g.toVault || g.settled || g.vault || g.validOn == null || g.id in done) continue
            if (g.validOn == day) used.put(g.id, engine.windowUsedSeconds(usage, g, day))
            val ended = g.validOn.isBefore(day) || (g.validOn == day && (if (w.end == java.time.LocalTime.of(23, 59)) false else !t.isBefore(w.end)))
            if (!ended) continue
            val sec = used.optLong(g.id, 0)
            due += g.id to (g.minutes - ((sec + 59) / 60).toInt()).coerceAtLeast(0)
        }
        prefs.edit().putString("grantUsed", used.toString()).apply()
        if (due.isEmpty()) return
        scope.launch(Dispatchers.IO) {
            val ok = mutableSetOf<String>()
            for ((id, left) in due) {
                runCatching { app.orbit.data.Api.rpc("device_grant_leftover", org.json.JSONObject().put("p_grant", id).put("p_minutes", left)) }
                    .onSuccess { ok += id }
            }
            if (ok.isNotEmpty()) {
                val cur = Store.prefs().getStringSet("grantLeftDone", emptySet()).orEmpty().toMutableSet()
                cur += ok
                Store.prefs().edit().putStringSet("grantLeftDone", cur.toList().takeLast(200).toSet()).apply()
                Live.syncRequested = true
            }
        }
    }

    private fun recordingTick(rec: app.orbit.data.RecState?, nowMs: Long) {
        val R = app.orbit.data.Recorder
        if (rec?.status == "recording" && !RecordService.running && nowMs - R.lastAlive > 15_000) {
            val n = R.update { it.copy(status = "paused") }
            if (n != null) {
                scope.launch(Dispatchers.IO) {
                    R.push(n, org.json.JSONObject().put("type", "gap").put("note", "kayıt durdu (uygulama ya da telefon kapandı)"))
                }
                runCatching { app.orbit.data.Notifier.recordingStopped(this, n.runId, n.title) }
            }
        }
        val needs = R.pending.value > 0 || rec?.dirty == true || (rec != null && !rec.active) ||
            Store.prefs().getString("recEvents", "[]") != "[]"
        if (needs && nowMs - lastRecPump > 20_000 && recBusy.compareAndSet(false, true)) {
            lastRecPump = nowMs
            scope.launch(Dispatchers.IO) {
                try { R.pump() } finally { recBusy.set(false) }
            }
        }
    }

    private var finishingTimer: String? = null

    private fun timerTick(
        engine: RuleEngine, snap: Snapshot, usage: app.orbit.engine.DayUsage, fg: String?, exempt: Set<String>,
        interactive: Boolean, dt: Long, nowMs: Long,
    ) {
        val s = app.orbit.data.Timers.active() ?: return
        if (s.running) {
            // Ekran kapalıyken (kitap okuma gibi) ya da Orbit/izinli uygulama öndeyken odaklı sayılır
            val onFocus = !interactive || fg == null || fg == packageName || fg in exempt || engine.verdict(fg, snap, usage).allowed
            val counts = app.orbit.data.Timers.tick(s, dt, onFocus)
            val left = s.remaining(nowMs)
            if (left != null && left <= 0 && finishingTimer != s.id) {
                finishingTimer = s.id
                scope.launch(Dispatchers.IO) {
                    app.orbit.data.Timers.finish(s, "auto", counts)
                    app.orbit.data.Notifier.show(app.orbit.data.Notifier.CH_TASKS, 7300, "⏱ Süre doldu", "${s.title} bitti. Aferin! 🎉", "TIMER")
                    Live.syncRequested = true
                }
                return
            }
            if (counts != null && app.orbit.data.Timers.shouldPush(nowMs)) {
                scope.launch(Dispatchers.IO) { app.orbit.data.Timers.pushCounts(s.id, counts.first, counts.second) }
            }
        } else if (s.status == "paused" && s.pauseMode == "limit" && s.byParent && s.pausedAt != null) {
            val max = (s.pauseMaxMinutes ?: 5) * 60_000L
            if (nowMs - s.pausedAt > max && finishingTimer != "resume:${s.id}") {
                finishingTimer = "resume:${s.id}"
                scope.launch(Dispatchers.IO) {
                    app.orbit.data.Timers.resume(s)
                    app.orbit.data.Notifier.show(app.orbit.data.Notifier.CH_TASKS, 7301, "⏱ Mola bitti", "${s.title} devam ediyor", "TIMER")
                    Live.syncRequested = true
                }
            }
        }
    }

    /** Kapalı uygulama penceresinde çocuğun göreceği açıklama (o anki duruma göre). */
    private fun blockedMessage(s: app.orbit.engine.Snapshot, mandatory: List<String>): String {
        val until = s.modeEndsAt?.toString()?.take(5)
        return when {
            s.parentMode -> "Orbit: Ebeveyn modu açık."
            s.locked -> "🌙 ${s.limitName ?: "Telefon sınırlandı"}: şu an sadece temel uygulamalar açık."
            s.activeMode != null && s.activeMode.othersBlocked ->
                "Şu an ${s.activeMode.name}" + (until?.let { " — $it'te biter." } ?: ".") + " Açık uygulamalar Orbit'te."
            mandatory.isNotEmpty() -> "Önce görevini yap: ${mandatory.first()}. Görev onaylanınca açılır."
            s.sectionMode && s.section == null -> "Şu an telefon kapalı saatlerde. Açık uygulamalar Orbit'te."
            s.sectionMode && s.section != null -> {
                val sec = s.section
                val end = sec.endsAt.toString().take(5)
                val head = (sec.section.icon?.let { "$it " } ?: "") + sec.section.name
                val msg = sec.section.message?.let { " $it" } ?: ""
                if (s.sectionClosed)
                    "$head ($end'e kadar).$msg Telefon bu saatlerde kapalı."
                else if (s.remainingSeconds <= 0)
                    "⏰ ${sec.section.name} süren bitti (${sec.section.name} $end'te biter). Orbit'ten ebeveyninden süre isteyebilirsin."
                else
                    "Şu an $head ($end'e kadar).$msg Bu uygulama bu bölümde kapalı, süresi dolmuş ya da onay bekliyor. Açık uygulamalar Orbit'te."
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
            app.orbit.data.Timers.active()?.let { t ->
                append(" · ⏱ ${t.title}")
                t.remaining()?.let { r -> append(" ${r / 60} dk") }
                if (!t.running) append(" (mola)")
            }
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
