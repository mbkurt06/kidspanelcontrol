package app.orbit.ui

import androidx.activity.compose.BackHandler
import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.BuildConfig
import app.orbit.data.Store
import app.orbit.data.Sync
import app.orbit.data.Tasks
import app.orbit.device.Policy
import app.orbit.engine.RuleEngine
import app.orbit.engine.SecRule
import app.orbit.engine.Snapshot
import app.orbit.engine.UNLIMITED_SECONDS
import app.orbit.service.Live
import app.orbit.update.Updater
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** Çocuğun Orbit ekranları (sol menüden). */
enum class Screen(val icon: String, val title: String) {
    TODAY("🏠", "Bugün"),
    TASKS("✅", "Görevlerim"),
    AGENDA("🗓", "Ajanda"),
    MESSAGES("💬", "Mesajlar"),
    TIMER("⏱", "Sayaç"),
    ALARMS("⏰", "Alarmlarım"),
    MUSIC("🎵", "Müzik"),
    WALLET("⏳", "Süre cüzdanı"),
    ASK("🙋", "Ebeveynden iste"),
    PROFILE("👤", "Profil"),
    VAULT("🔑", "Şifrelerim"),
    ABOUT("ℹ️", "Hakkında"),
}

private fun hm(t: java.time.LocalTime) = t.toString().take(5)

@Composable
fun OrbitHome(request: Pair<Screen, Long>? = null) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    var screen by rememberSaveable { mutableStateOf(Screen.TODAY) }
    LaunchedEffect(request) { request?.let { screen = it.first } }
    val messages by app.orbit.data.Messages.list.collectAsState()
    val unreadMsgs = messages.count { it.fromParent && !it.read }
    val live by Live.state.collectAsState()
    val profileRules = remember(live.lastSync) { Store.rules() }
    val openTasks = remember(live.lastSync, live.snapshot?.now?.minute) { Tasks.current().count { it.open && it.inWindow() } }
    val focusNow = remember(live.lastSync, live.snapshot?.now?.minute) { app.orbit.data.Timers.activeFocus() }
    val taskScreenSets = profileRules.taskRestrictions.filter { it.active && it.screens.isNotEmpty() }.map { it.screens }
    val taskScreens = taskScreenSets.reduceOrNull { a, b -> a intersect b }
    // Tam kilit: sadece izin verilen ekranlar
    val kiosk = live.kiosk
    // "Hakkında" (sürüm, son güncelleme) her durumda görünür
    fun visible(s: Screen) = s == Screen.ABOUT ||
        (kiosk == null || s == Screen.TODAY || s.kioskKey() in kiosk.screens) &&
            (focusNow == null || focusNow.screens.isEmpty() || s == Screen.TODAY || s.kioskKey() in focusNow.screens) &&
            (taskScreens == null || s == Screen.TODAY || s.kioskKey() in taskScreens)
    LaunchedEffect(kiosk?.screens, taskScreens) { if (!visible(screen)) screen = Screen.TODAY }
    var pinOpen by remember { mutableStateOf(false) }
    if (pinOpen) PinDialog { pinOpen = false }
    BackHandler(enabled = drawer.isOpen || screen != Screen.TODAY) {
        if (drawer.isOpen) scope.launch { drawer.close() } else screen = Screen.TODAY
    }

    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet(drawerContainerColor = C.surface) {
                Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable {
                            screen = Screen.PROFILE
                            scope.launch { drawer.close() }
                        }.padding(vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        OrbitAvatar(profileRules.profileAvatar, Modifier.size(46.dp))
                        Spacer(Modifier.width(10.dp))
                        Text(Store.childName.ifBlank { "Orbit" }, color = C.text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                    }
                    Spacer(Modifier.height(12.dp))
                    for (s in Screen.entries) {
                        if (s == Screen.PROFILE) continue
                        if (!visible(s)) continue
                        if (s == Screen.MESSAGES && focusNow?.messagesAllowed == false) continue
                        val on = s == screen
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                                .background(if (on) C.surface2 else Color.Transparent)
                                .clickable {
                                    screen = s
                                    scope.launch { drawer.close() }
                                }
                                .padding(horizontal = 12.dp, vertical = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(s.icon, fontSize = 20.sp)
                            Spacer(Modifier.width(14.dp))
                            Text(s.title, color = C.text, fontSize = 16.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal, modifier = Modifier.weight(1f))
                            if (s == Screen.TASKS && openTasks > 0) Badge(openTasks)
                            if (s == Screen.MESSAGES && unreadMsgs > 0) Badge(unreadMsgs)
                        }
                    }
                    if (live.pinUntil != null) {
                        Spacer(Modifier.height(12.dp))
                        Muted("🔓 Ebeveyn modu açık", 13)
                        Text(
                            "Kilitle",
                            color = C.accent,
                            modifier = Modifier.clip(RoundedCornerShape(12.dp)).clickable {
                                app.orbit.data.Kiosk.lockAgain()
                                Live.syncRequested = true
                                scope.launch { drawer.close() }
                            }.padding(12.dp),
                        )
                    } else if (Store.rules().pinHash != null) {
                        Spacer(Modifier.height(12.dp))
                        Text(
                            "🔐 Ebeveyn girişi",
                            color = C.muted,
                            modifier = Modifier.clip(RoundedCornerShape(12.dp)).clickable {
                                pinOpen = true
                                scope.launch { drawer.close() }
                            }.padding(12.dp),
                        )
                    }
                }
            }
        },
    ) {
        Column(Modifier.fillMaxSize().background(C.bg)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(48.dp).clip(CircleShape).clickable { scope.launch { drawer.open() } },
                    contentAlignment = Alignment.Center,
                ) { Text("☰", color = C.text, fontSize = 24.sp) }
                if (screen == Screen.TODAY) {
                    OrbitAvatar(
                        profileRules.profileAvatar,
                        Modifier.size(36.dp).clickable { screen = Screen.PROFILE },
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(Store.childName.ifBlank { "Orbit" }, color = C.text, fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                } else {
                    Text(screen.title, color = C.text, fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                }
                if (screen != Screen.MESSAGES && unreadMsgs > 0 && visible(Screen.MESSAGES)) {
                    Box(Modifier.clip(RoundedCornerShape(12.dp)).clickable { screen = Screen.MESSAGES }.padding(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) { Text("💬", fontSize = 16.sp); Spacer(Modifier.width(4.dp)); Badge(unreadMsgs) }
                    }
                }
                if (screen != Screen.TASKS && openTasks > 0 && visible(Screen.TASKS)) {
                    Box(Modifier.clip(RoundedCornerShape(12.dp)).clickable { screen = Screen.TASKS }.padding(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) { Text("✅", fontSize = 16.sp); Spacer(Modifier.width(4.dp)); Badge(openTasks) }
                    }
                }
                Box(Modifier.padding(8.dp).size(10.dp).clip(CircleShape).background(if (live.online) C.good else C.muted))
            }
            if (screen == Screen.MESSAGES) {
                val f = remember(live.lastSync) { app.orbit.data.Timers.activeFocus() }
                if (f?.messagesAllowed == false) {
                    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                        Muted("Odak: ${f.name} — mesajlar sayaç bitene kadar kapalı.")
                    }
                } else MessagesScreen()
                return@Column
            }
            if (screen == Screen.AGENDA || screen == Screen.ALARMS || screen == Screen.TIMER) {
                Box(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
                    when (screen) {
                        Screen.AGENDA -> AgendaScreen { if (visible(Screen.TASKS)) screen = Screen.TASKS }
                        Screen.ALARMS -> AlarmsScreen()
                        Screen.TIMER -> TimerScreen()
                        else -> Unit
                    }
                }
            } else Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                when (screen) {
                    Screen.TODAY -> if (kiosk != null) KioskToday(kiosk) { screen = it } else TodayScreen { if (visible(it)) screen = it }
                    Screen.TASKS -> TasksCard(remember(live.lastSync, live.snapshot?.now?.minute) { Tasks.current().filter { !it.open || it.inWindow() } })
                    Screen.WALLET -> WalletScreen()
                    Screen.ASK -> AskScreen()
                    Screen.PROFILE -> ProfileScreen()
                    Screen.ABOUT -> AboutScreen()
                    Screen.VAULT -> VaultScreen(onCancel = { screen = Screen.TODAY })
                    Screen.MESSAGES -> Unit
                    Screen.TIMER -> TimerScreen()
                    Screen.MUSIC -> MusicScreen()
                    Screen.AGENDA -> Unit
                    Screen.ALARMS -> Unit
                }
            }
        }
    }
}

@Composable
private fun Badge(n: Int) {
    Box(Modifier.clip(CircleShape).background(C.accent).padding(horizontal = 8.dp, vertical = 2.dp)) {
        Text("$n", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
    }
}

// --- Bugün ---------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TodayScreen(go: (Screen) -> Unit) {
    val ctx = LocalContext.current
    val live by Live.state.collectAsState()
    val s = live.snapshot

    if (!Policy.hasUsageAccess(ctx)) {
        Card {
            Text("Kullanım erişimi gerekli", color = C.warn, fontWeight = FontWeight.SemiBold)
            Muted("Orbit'in süreyi sayabilmesi için bu izni bir ebeveyn açmalı.")
            OutlinedButton(onClick = {
                runCatching { ctx.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }) { Text("Ayarı aç") }
        }
    }
    if (s == null) {
        Muted("Kurallar yükleniyor…")
        return
    }

    if (s.parentMode) {
        Card {
            Text("Ebeveyn modu açık", color = C.warn, fontWeight = FontWeight.SemiBold)
            Muted(
                "Bütün sınırlamalar geçici olarak kalktı" +
                    (s.parentModeUntil?.let { " · " + hm(java.time.Instant.ofEpochMilli(it).atZone(java.time.ZoneId.systemDefault()).toLocalTime()) + "'e kadar" } ?: "")
            )
        }
    }

    NowCard(s)

    val running = remember(live.lastSync) { app.orbit.data.Timers.active() }
    if (running != null) RunningTimerCard(running, compact = true) { go(Screen.TIMER) }
    else Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.surface).clickable { go(Screen.TIMER) }.padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("⏱", fontSize = 22.sp)
        Spacer(Modifier.width(12.dp))
        Text("Çalışma sayacı başlat", color = C.text, modifier = Modifier.weight(1f))
        Muted("›", 16)
    }

    // Zorunlu görev uyarısı
    val blocking = remember(live.lastSync, s.now.minute) { Tasks.current().filter { it.blocking } }
    if (blocking.isNotEmpty()) {
        Card {
            Text("Önce görevini yap", color = C.warn, fontWeight = FontWeight.SemiBold)
            Muted(blocking.joinToString(" · ") { it.title } + " — bitince süreli uygulamalar açılır.")
            Button(onClick = { go(Screen.TASKS) }, colors = ButtonDefaults.buttonColors(containerColor = C.accent)) { Text("Görevlerime git") }
        }
    }

    // Sıradaki bölüm
    val engine = remember(live.lastSync) { RuleEngine(Store.rules()) }
    val next = remember(live.lastSync, s.now.minute) {
        val cur = s.section?.section?.id
        engine.daySections(s.day).filter { it.id != cur && it.start > s.now }.minByOrNull { it.start }
    }
    if (next != null) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.surface).padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(next.icon ?: "⏭", fontSize = 22.sp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Muted("Sıradaki · ${hm(next.start)}", 12)
                Text(next.name, color = C.text, fontWeight = FontWeight.SemiBold)
            }
            Muted(next.budgetMinutes?.let { minutesText(it.toLong()) } ?: "", 13)
        }
    }

    if (s.walletGrants.isNotEmpty()) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.surface).clickable { go(Screen.WALLET) }.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("⏳", fontSize = 22.sp)
            Spacer(Modifier.width(12.dp))
            Text("Cüzdanında ${minutesText(s.walletGrants.sumOf { it.minutes }.toLong())} var", color = C.text, modifier = Modifier.weight(1f))
            Muted("Kullan ›", 13)
        }
    }

    Card {
        Title("Şu an açık")
        if (live.allowedApps.isEmpty()) Muted("Şu an açık uygulama yok.")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for ((pkg, label) in live.allowedApps) AppTile(pkg, label) { launch(ctx, pkg) }
        }
    }
}

/** Şu anki bölüm / durum büyük kartı + kalan süre. */
@Composable
private fun NowCard(s: Snapshot) {
    val mode = s.activeMode
    val sec = s.section?.section
    val icon = when {
        s.locked -> "🌙"
        s.freeName != null -> "🟢"
        mode != null -> "⭐"
        sec != null -> sec.icon ?: if (s.sectionClosed) "🌙" else "☀️"
        else -> "🌙"
    }
    val title = when {
        s.locked -> s.limitName ?: "Sınırlı"
        s.freeName != null -> s.freeName
        mode != null -> mode.name
        sec != null -> sec.name
        s.sectionMode -> "Kapalı saatler"
        else -> "Bugün"
    }
    val until = when {
        mode != null && s.modeEndsAt != null -> "${hm(s.modeEndsAt)}'e kadar"
        sec != null -> "${hm(s.section!!.endsAt)}'e kadar"
        else -> null
    }
    val message = if (mode == null && !s.locked) sec?.message else null
    val unlimited = s.remainingSeconds >= UNLIMITED_SECONDS

    Card {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(icon, fontSize = 40.sp)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(title, color = C.text, fontSize = 24.sp, fontWeight = FontWeight.Bold)
                until?.let { Muted(it, 14) }
            }
        }
        message?.let { Text(it, color = C.text, fontSize = 16.sp) }
        // Kilitli ekranda da gün özeti görünür; çocuk kalan ve toplam kullanılan süreyi görebilir.
        Row(verticalAlignment = Alignment.CenterVertically) {
            val frac = if (unlimited) 1f else if (s.allowanceMinutes > 0) s.remainingSeconds / (s.allowanceMinutes * 60f) else 0f
            Ring(frac, if (unlimited || s.remainingSeconds > 600) C.blue else C.warn, 110.dp) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(if (unlimited) "∞" else minutesText(s.remainingSeconds / 60), color = C.text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    Muted(if (unlimited) "sınırsız" else "kaldı", 12)
                }
            }
            Spacer(Modifier.width(16.dp))
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Muted(if (unlimited) "Bugün kalan: sınırsız" else "Bugün kalan: ${minutesText(s.remainingSeconds / 60)}")
                Muted("Toplam kullanılan: ${minutesText(s.usedMinutes.toLong())}")
                if (s.sectionMode) {
                    s.sectionLeftSeconds?.let { Muted("Bu bölümde: ${minutesText(it / 60)}") }
                    if (s.poolLeftSeconds > 0) Muted("Ekstra süre: ${minutesText(s.poolLeftSeconds / 60)}")
                    s.capLeftSeconds?.let { Muted("Bugün en fazla: ${minutesText(it / 60)} daha") }
                } else {
                    Muted("Bugünkü hak: ${minutesText(s.allowanceMinutes.toLong())}")
                    if (s.extraMinutesToday != 0) Muted("Ekstra: ${minutesText(s.extraMinutesToday.toLong())}")
                }
                s.modeRemainingSeconds?.let { Muted("Durum süresi: ${minutesText(it / 60)}") }
            }
        }
        if (s.sectionMode && s.sectionClosed) {
            Muted("Şu an sadece her zaman açık uygulamalar kullanılabilir.")
        }
    }
}

// --- Günüm ---------------------------------------------------------------

@Composable
private fun DayScreen() {
    val live by Live.state.collectAsState()
    val s = live.snapshot ?: return Muted("Kurallar yükleniyor…")
    val engine = remember(live.lastSync) { RuleEngine(Store.rules()) }
    val sections = remember(live.lastSync, s.day) { engine.daySections(s.day) }
    val windows = remember(live.lastSync, s.day) { engine.dayWindows(s.day) }
    val usage = live.usage

    if (sections.isEmpty()) {
        Card { Muted("Bugün için bölüm yok. Kurallar: günlük ${minutesText(s.allowanceMinutes.toLong())}.") }
        return
    }
    Muted("Bugünün planı. Süreli uygulamalar o bölümün süresinden düşer.", 13)
    for (sec in sections) {
        val now = s.section?.section?.id == sec.id
        val past = !sec.crossesMidnight && sec.end <= s.now && !now
        val used = usage?.buckets?.get("s:${sec.id}@${s.day}") ?: 0L
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp))
                .background(if (now) C.surface2 else C.surface)
                .padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(sec.icon ?: when (sec.defaultRule) { SecRule.BLOCKED -> "🌙"; SecRule.OPEN -> "🟢"; SecRule.TIMED -> "☀️" }, fontSize = 26.sp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(sec.name, color = if (past) C.muted else C.text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                    if (now) {
                        Spacer(Modifier.width(8.dp))
                        Text("ŞU AN", color = C.accent, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    }
                }
                Muted("${hm(sec.start)}–${hm(sec.end)}" + (sec.budgetMinutes?.let { " · ${minutesText(it.toLong())}" } ?: ""), 13)
                sec.message?.let { Muted(it, 13) }
                if (sec.budgetMinutes != null && used > 0) Muted("Kullanılan: ${minutesText(used / 60)}", 12)
                if (sec.carryOver) Muted("Kalan süre sonraki bölüme geçer", 12)
            }
        }
    }
    for (g in windows) {
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(C.surface).padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("🎁", fontSize = 26.sp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(g.note ?: "Ekstra süre", color = C.text, fontWeight = FontWeight.SemiBold)
                Muted("${hm(g.window!!.start)}–${hm(g.window.end)} · ${minutesText(g.minutes.toLong())}", 13)
            }
        }
    }
}

// --- Süre cüzdanı ----------------------------------------------------------

@Composable
private fun WalletScreen() {
    val scope = rememberCoroutineScope()
    val live by Live.state.collectAsState()
    val s = live.snapshot ?: return Muted("Kurallar yükleniyor…")
    var msg by remember { mutableStateOf("") }
    val rules = remember(live.lastSync) { Store.rules() }
    val vaultMin = rules.grants.filter { it.vault }.sumOf { it.minutes }
    val today = rules.grants.filter { !it.vault && (it.validOn == s.day || it.activatedOn == s.day) }

    val walletTotal = s.walletGrants.sumOf { it.minutes }
    val usedToday = rules.grants.filter { it.activatedOn == s.day }.sumOf { it.minutes }
    val limitLeft = rules.walletDailyMax?.let { (it - usedToday).coerceAtLeast(0) }
    val maxUse = minOf(walletTotal, limitLeft ?: walletTotal)
    var busy by remember { mutableStateOf(false) }
    Card {
        Row(verticalAlignment = Alignment.CenterVertically) { Title("Cüzdanım"); Spacer(Modifier.width(6.dp)); Info("Cüzdandaki süreyi çocuk kullanabilir; yalnızca izin verilen saatlerde ve günlük sınır içinde geçerlidir.") }
        if (s.walletGrants.isEmpty()) {
            Muted("Cüzdanında süre yok. Görevlerini yaparak süre kazanabilirsin.")
        } else {
            Text(minutesText(walletTotal.toLong()), color = C.text, fontSize = 26.sp, fontWeight = FontWeight.Bold)
            for (g in s.walletGrants) {
                Muted("${minutesText(g.minutes.toLong())}" + listOfNotNull(g.note, g.expiresOn?.let { "son gün $it" }).joinToString(" · ", prefix = " · ").removeSuffix(" · "), 12)
            }
            rules.walletDailyMax?.let {
                Muted("Günde en fazla ${minutesText(it.toLong())} kullanabilirsin · bugün kalan ${minutesText((limitLeft ?: 0).toLong())}", 13)
            }
            Muted("Bugüne eklenir; izin verilen saatlerde kullanırsın.", 13)
            if (maxUse > 0) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    for (m in listOf(10, 15, 30).filter { it < maxUse } + maxUse) {
                        Button(
                            enabled = !busy,
                            onClick = {
                                busy = true
                                scope.launch {
                                    val err = withContext(Dispatchers.IO) { Sync.useWallet(m) }
                                    msg = err ?: "+${minutesText(m.toLong())} bugüne eklendi"
                                    busy = false
                                    Live.syncRequested = true
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = C.accent),
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                        ) { Text("$m dk", fontSize = 13.sp) }
                    }
                }
            } else if (limitLeft == 0) {
                Muted("Bugünkü cüzdan sınırın doldu.", 13)
            }
        }
        if (msg.isNotEmpty()) Text(msg, color = C.good)
    }
    if (vaultMin > 0) {
        Card {
            Row(verticalAlignment = Alignment.CenterVertically) { Title("Süre kasası"); Spacer(Modifier.width(6.dp)); Info("Bu süre ebeveyn tarafından daha sonra bir güne veya bölüme aktarılır.") }
            Text(minutesText(vaultMin.toLong()), color = C.text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Muted("Kazandığın bu süre ebeveyninde. Ne zaman kullanacağını o planlayacak.")
        }
    }
    if (today.isNotEmpty()) {
        Card {
            Row(verticalAlignment = Alignment.CenterVertically) { Title("Bugünkü ekstra süreler"); Spacer(Modifier.width(6.dp)); Info("Bugün için açılmış ek sürelerin kısa dökümü.") }
            for (g in today) {
                val where = when {
                    g.window != null -> "${hm(g.window.start)}–${hm(g.window.end)} arası"
                    g.sectionId != null -> rules.sections.firstOrNull { it.id == g.sectionId }?.name ?: "bölüm"
                    else -> "gün boyu"
                }
                Muted("+${minutesText(g.minutes.toLong())} · $where" + (g.note?.let { " · $it" } ?: ""))
            }
        }
    }
}

// --- Ebeveynden iste -------------------------------------------------------

@Composable
private fun AskScreen() {
    val scope = rememberCoroutineScope()
    val live by Live.state.collectAsState()
    var note by remember { mutableStateOf("") }
    var msg by remember { mutableStateOf("") }
    var sent by remember { mutableStateOf(setOf<String>()) }
    val pending = remember(live.lastSync) { Store.rules().apps.values.filter { !it.approved }.sortedBy { it.label.lowercase() } }

    fun send(type: String, payload: JSONObject, key: String) {
        scope.launch {
            val ok = withContext(Dispatchers.IO) { Sync.event(type, payload.put("note", note)) }
            msg = if (ok) "İstek gönderildi" else "İnternet gerekli"
            if (ok) { sent = sent + key; note = "" }
        }
    }

    Card {
        Title("Ne istiyorsun?")
        OutlinedTextField(note, { note = it.take(120) }, label = { Text("Neden? (isteğe bağlı)") }, modifier = Modifier.fillMaxWidth())
        Button(
            onClick = { send("time_request", JSONObject(), "time") },
            colors = ButtonDefaults.buttonColors(containerColor = C.accent),
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Ek süre iste") }
        if (msg.isNotEmpty()) Text(msg, color = C.good)
    }
    if (pending.isNotEmpty()) {
        Card {
            Title("Onay bekleyen uygulamalar")
            Muted("Açılmasını istediğin uygulama için ebeveynine istek gönder.", 13)
            for (a in pending) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AppIcon(a.pkg, 36.dp)
                    Spacer(Modifier.width(10.dp))
                    Text(a.label, color = C.text, modifier = Modifier.weight(1f))
                    if (a.pkg in sent) Muted("gönderildi", 12)
                    else OutlinedButton(onClick = { send("app_request", JSONObject().put("package", a.pkg).put("label", a.label), a.pkg) }) { Text("İste") }
                }
            }
        }
    }
}

// --- Hakkında --------------------------------------------------------------

@Composable
private fun AboutScreen() {
    val ctx = LocalContext.current
    val live by Live.state.collectAsState()
    Card {
        Title("Orbit ${BuildConfig.VERSION_NAME}")
        Muted("Bağlantı: " + if (live.online) "bağlı" else "çevrimdışı")
        Muted("Canlı bağlantı: " + if (app.orbit.data.Realtime.isConnected) "açık (değişiklikler anında gelir)" else "kapalı (30 sn'de bir kontrol)")
        Muted("Son eşitleme: " + if (live.lastSync > 0) java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(live.lastSync)) else "henüz yok")
        Muted("Cihaz yöneticisi: " + if (Policy.isOwner(ctx)) "evet" else "hayır")
        Muted("Kullanım erişimi: " + if (Policy.hasUsageAccess(ctx)) "açık" else "kapalı")
        Updater.status().takeIf { it.isNotBlank() }?.let { Muted("Güncelleme: $it") }
        Muted(
            "Son güncelleme: " + if (Store.lastUpdateAt > 0) {
                java.text.SimpleDateFormat("dd.MM.yyyy · HH:mm", java.util.Locale("tr", "TR")).format(java.util.Date(Store.lastUpdateAt))
            } else "henüz yok",
        )
    }
}
