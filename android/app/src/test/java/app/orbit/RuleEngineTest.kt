package app.orbit

import app.orbit.engine.AppRule
import app.orbit.engine.Command
import app.orbit.engine.CommandType
import app.orbit.engine.DayOverride
import app.orbit.engine.DayUsage
import app.orbit.engine.Grant
import app.orbit.engine.Group
import app.orbit.engine.Mode
import app.orbit.engine.ModeSlot
import app.orbit.engine.Profile
import app.orbit.engine.RuleEngine
import app.orbit.engine.Rules
import app.orbit.engine.TimeWindow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

class RuleEngineTest {
    private val zone = ZoneId.of("Europe/Berlin")
    // 2026-10-21 bir Çarşamba (ISO 3)
    private val day = LocalDate.of(2026, 10, 21)
    private fun at(h: Int, m: Int = 0, d: LocalDate = day) = ZonedDateTime.of(d, LocalTime.of(h, m), zone)
    private fun t(s: String) = LocalTime.parse(s)

    private val weekday = Profile("p1", "Hafta içi", 90, null, listOf(TimeWindow(t("07:00"), t("21:00"))), listOf(TimeWindow(t("07:00"), t("21:00"))), listOf(10, 2))
    private val gameTime = Mode("m-game", "Oyun zamanı", "#fff", setOf("com.game1", "com.game2", "com.game3"), emptySet(), 30, false, false, false, listOf(5), 60)
    private val sleep = Mode("m-sleep", "Uyku", "#000", emptySet(), setOf(Group.ALWAYS_OPEN), null, false, true, false, listOf(5), 90)
    private val rest = Mode("m-rest", "Dinlenme", "#000", setOf("com.music"), emptySet(), null, false, true, false, listOf(5), 70)

    private val apps = listOf(
        AppRule("com.phone", "Telefon", Group.ALWAYS_OPEN, true, null),
        AppRule("com.yt", "YouTube", Group.TIMED, true, 45),
        AppRule("com.insta", "Insta", Group.TIMED, true, null),
        AppRule("com.wa", "WhatsApp", Group.UNLIMITED, true, null),
        AppRule("com.music", "Müzik", Group.UNLIMITED, true, null),
        AppRule("com.game1", "Oyun 1", Group.BLOCKED, true, null),
        AppRule("com.game2", "Oyun 2", Group.BLOCKED, true, null),
        AppRule("com.new", "Yeni", Group.BLOCKED, false, null),
    ).associateBy { it.pkg }

    private fun rules(
        slots: List<ModeSlot> = emptyList(),
        grants: List<Grant> = emptyList(),
        commands: List<Command> = emptyList(),
        overrides: List<DayOverride> = emptyList(),
    ) = Rules(
        apps = apps,
        profiles = mapOf("p1" to weekday),
        modes = listOf(gameTime, sleep, rest).associateBy { it.id },
        slots = slots,
        assignments = (1..7).associateWith { "p1" },
        overrides = overrides,
        grants = grants,
        commands = commands,
    )

    private fun ms(z: ZonedDateTime) = z.toInstant().toEpochMilli()

    @Test
    fun timedAppsCountAndStopWhenTimeRunsOut() {
        val e = RuleEngine(rules())
        var u = DayUsage(day)
        var s = e.snapshot(at(15), u)
        assertEquals(90, s.allowanceMinutes)
        val v = e.verdict("com.insta", s, u)
        assertTrue(v.allowed); assertTrue(v.countsDaily)
        u = e.account(u, "com.insta", v, 90 * 60)
        s = e.snapshot(at(16), u)
        assertEquals(0L, s.remainingSeconds)
        assertFalse(e.verdict("com.insta", s, u).allowed)
        // Sınırsız ve her zaman açık uygulamalar süre bitse de açık
        assertTrue(e.verdict("com.wa", s, u).allowed)
        assertTrue(e.verdict("com.phone", s, u).allowed)
    }

    @Test
    fun unlimitedAppsDoNotCountButRespectWindows() {
        val e = RuleEngine(rules())
        val u = DayUsage(day)
        val v = e.verdict("com.wa", e.snapshot(at(15), u), u)
        assertTrue(v.allowed); assertFalse(v.countsDaily)
        assertFalse(e.verdict("com.wa", e.snapshot(at(22), u), u).allowed)
    }

    @Test
    fun perAppLimit() {
        val e = RuleEngine(rules())
        var u = DayUsage(day)
        val s = e.snapshot(at(15), u)
        u = e.account(u, "com.yt", e.verdict("com.yt", s, u), 45 * 60)
        val s2 = e.snapshot(at(15, 50), u)
        assertFalse(e.verdict("com.yt", s2, u).allowed)
        assertTrue(e.verdict("com.insta", s2, u).allowed)
    }

    @Test
    fun gameTimeModeHasOwnBudgetAndDoesNotTouchDaily() {
        // Oyun zamanı: 3 oyun, 30 dk, 16:00–18:00, günlük süreyi etkilemez, diğerleri normal
        val e = RuleEngine(rules(slots = listOf(ModeSlot("p1", "m-game", (1..7).toSet(), t("16:00"), t("18:00")))))
        var u = DayUsage(day)
        assertFalse("oyun zamanı dışında kapalı", e.verdict("com.game1", e.snapshot(at(15), u), u).allowed)
        var s = e.snapshot(at(16, 30), u)
        assertEquals("Oyun zamanı", s.activeMode?.name)
        val v = e.verdict("com.game1", s, u)
        assertTrue(v.allowed); assertFalse(v.countsDaily); assertEquals("m-game", v.countsMode)
        u = e.account(u, "com.game1", v, 30 * 60)
        s = e.snapshot(at(17), u)
        assertEquals(90 * 60L, s.remainingSeconds)
        assertFalse("30 dk bitti", e.verdict("com.game1", s, u).allowed)
        assertTrue("diğerleri normal kurallarla açık", e.verdict("com.insta", s, u).allowed)
    }

    @Test
    fun sleepCrossesMidnightAndBlocksOthers() {
        val e = RuleEngine(rules(slots = listOf(ModeSlot("p1", "m-sleep", (1..7).toSet(), t("21:30"), t("07:00")))))
        val u = DayUsage(day)
        val night = e.snapshot(at(22), u)
        assertEquals("Uyku", night.activeMode?.name)
        assertFalse(e.verdict("com.wa", night, u).allowed)
        assertTrue(e.verdict("com.phone", night, u).allowed)
        val early = e.snapshot(at(6, 30, day.plusDays(1)), DayUsage(day.plusDays(1)))
        assertEquals("Uyku", early.activeMode?.name)
        val morning = e.snapshot(at(7, 30, day.plusDays(1)), DayUsage(day.plusDays(1)))
        assertNull(morning.activeMode)
    }

    @Test
    fun restModeAllowsChosenApps() {
        val e = RuleEngine(rules(slots = listOf(ModeSlot("p1", "m-rest", setOf(3), t("13:00"), t("14:00")))))
        val u = DayUsage(day)
        val s = e.snapshot(at(13, 15), u)
        assertTrue(e.verdict("com.music", s, u).allowed)
        assertFalse(e.verdict("com.insta", s, u).allowed)
        // Başka günde geçerli değil
        assertNull(e.snapshot(at(13, 15, day.plusDays(1)), u).activeMode)
    }

    @Test
    fun higherPriorityModeWins() {
        val e = RuleEngine(rules(slots = listOf(
            ModeSlot("p1", "m-game", (1..7).toSet(), t("20:00"), t("22:00")),
            ModeSlot("p1", "m-sleep", (1..7).toSet(), t("21:30"), t("07:00")),
        )))
        assertEquals("Uyku", e.snapshot(at(21, 45), DayUsage(day)).activeMode?.name)
        assertEquals("Oyun zamanı", e.snapshot(at(21, 0), DayUsage(day)).activeMode?.name)
    }

    @Test
    fun grantsAndAdjustmentsChangeAllowance() {
        val created = ms(at(9))
        val e = RuleEngine(rules(
            grants = listOf(
                Grant("g1", 20, day, null, null, null),
                Grant("g2", 15, day.plusDays(1), null, null, null),
                Grant("g3", 10, null, null, day, null),
                Grant("g4", 30, null, null, null, "sinema"),
            ),
            commands = listOf(Command("c1", CommandType.ADJUST, created, null, null, -5, false, false)),
        ))
        val s = e.snapshot(at(15), DayUsage(day))
        assertEquals(90 + 20 + 10 - 5, s.allowanceMinutes)
        assertEquals(listOf("g4"), s.walletGrants.map { it.id })
    }

    @Test
    fun maxTotalCapsAllowance() {
        val r = rules(grants = listOf(Grant("g1", 200, day, null, null, null)))
        val e = RuleEngine(r.copy(profiles = mapOf("p1" to weekday.copy(maxTotalMinutes = 180))))
        assertEquals(180, e.snapshot(at(15), DayUsage(day)).allowanceMinutes)
    }

    @Test
    fun lockAndUnlockCommands() {
        val lock = Command("c1", CommandType.LOCK, ms(at(14)), null, null, null, false, false)
        val e = RuleEngine(rules(commands = listOf(lock)))
        val s = e.snapshot(at(15), DayUsage(day))
        assertTrue(s.locked)
        assertFalse(e.verdict("com.wa", s, DayUsage(day)).allowed)
        assertTrue(e.verdict("com.phone", s, DayUsage(day)).allowed)
        val unlock = Command("c2", CommandType.UNLOCK, ms(at(14, 30)), null, null, null, false, false)
        assertFalse(RuleEngine(rules(commands = listOf(lock, unlock))).snapshot(at(15), DayUsage(day)).locked)
        // Süreli kilit dolunca açılır
        val timed = Command("c3", CommandType.LOCK, ms(at(14)), ms(at(14, 30)), null, null, false, false)
        assertFalse(RuleEngine(rules(commands = listOf(timed))).snapshot(at(15), DayUsage(day)).locked)
    }

    @Test
    fun manualModeOverridesSchedule() {
        val start = Command("c1", CommandType.START_MODE, ms(at(14)), ms(at(15)), "m-game", null, false, false)
        val e = RuleEngine(rules(commands = listOf(start)))
        val s = e.snapshot(at(14, 30), DayUsage(day))
        assertEquals("Oyun zamanı", s.activeMode?.name)
        assertTrue(s.modeIsManual)
        assertNull(e.snapshot(at(15, 30), DayUsage(day)).activeMode)
        val end = Command("c2", CommandType.END_MODE, ms(at(14, 10)), null, null, null, false, false)
        assertNull(RuleEngine(rules(commands = listOf(start, end))).snapshot(at(14, 30), DayUsage(day)).activeMode)
    }

    @Test
    fun unapprovedAppsStayClosed() {
        val e = RuleEngine(rules())
        val u = DayUsage(day)
        val v = e.verdict("com.new", e.snapshot(at(15), u), u)
        assertFalse(v.allowed)
        assertEquals("Ebeveyn onayı bekliyor", v.reason)
        assertFalse(e.verdict("com.unknown", e.snapshot(at(15), u), u).allowed)
    }

    @Test
    fun dayOverrideChangesMinutes() {
        val e = RuleEngine(rules(overrides = listOf(DayOverride(day, null, 180, "Bayram"))))
        assertEquals(180, e.snapshot(at(12), DayUsage(day)).allowanceMinutes)
        assertEquals(90, e.snapshot(at(12, 0, day.plusDays(1)), DayUsage(day.plusDays(1))).allowanceMinutes)
    }

    @Test
    fun warningsFireOnce() {
        val e = RuleEngine(rules())
        var u = DayUsage(day)
        u = e.account(u, "com.insta", e.verdict("com.insta", e.snapshot(at(15), u), u), 81 * 60)
        val s = e.snapshot(at(16), u)
        val w = e.dueWarnings(s, u)
        assertEquals(1, w.size)
        u = u.copy(warned = u.warned + w.map { it.first })
        assertTrue(e.dueWarnings(s, u).isEmpty())
    }

    @Test
    fun noProfileFallsBackToDefault() {
        val e = RuleEngine(rules().copy(assignments = emptyMap()))
        assertEquals(60, e.snapshot(at(12), DayUsage(day)).allowanceMinutes)
    }
}
