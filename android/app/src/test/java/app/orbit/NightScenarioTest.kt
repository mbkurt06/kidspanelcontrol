package app.orbit

import app.orbit.engine.AppRule
import app.orbit.engine.Command
import app.orbit.engine.CommandType
import app.orbit.engine.DayUsage
import app.orbit.engine.Grant
import app.orbit.engine.Group
import app.orbit.engine.Profile
import app.orbit.engine.RuleEngine
import app.orbit.engine.Rules
import app.orbit.engine.SecRule
import app.orbit.engine.Section
import app.orbit.engine.TimeWindow
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

/** Bu gece yaşanan durumlar: gün bitişi (05:00), kilitliyken hak, gece verilen süre, eski aralıklı süreler. */
class NightScenarioTest {
    private val zone = ZoneId.of("Europe/Berlin")
    private val day = LocalDate.of(2026, 10, 21)
    private val next = day.plusDays(1)
    private fun at(h: Int, m: Int = 0, d: LocalDate = day) = ZonedDateTime.of(d, LocalTime.of(h, m), zone)
    private fun t(s: String) = LocalTime.parse(s)
    private fun w(a: String, b: String) = TimeWindow(t(a), t(b))

    private val sections = listOf(
        Section("sabah", "p1", "Sabah", t("07:00"), t("08:00"), 15, false, SecRule.BLOCKED, 0),
        Section("okul", "p1", "Okul", t("08:00"), t("14:00"), null, false, SecRule.BLOCKED, 1),
        Section("serbest", "p1", "Serbest", t("16:00"), t("19:00"), 60, true, SecRule.TIMED, 2),
        Section("aksam", "p1", "Akşam", t("19:00"), t("21:00"), 30, false, SecRule.TIMED, 3),
        Section("uyku", "p1", "Uyku", t("21:00"), t("07:00"), null, false, SecRule.BLOCKED, 4),
    )

    private fun rules(grants: List<Grant>) = Rules(
        apps = mapOf("com.insta" to AppRule("com.insta", "Insta", Group.TIMED, true, null)),
        profiles = mapOf("p1" to Profile("p1", "Hafta içi", 90, null, emptyList(), emptyList(), listOf(10, 2))),
        assignments = (1..7).associateWith { "p1" },
        grants = grants,
        sections = sections,
    )

    private fun g(id: String, min: Int, on: LocalDate, win: TimeWindow, note: String? = null) =
        Grant(id, min, on, null, null, note, window = win, toVault = note == null, source = "manual")

    private fun use(e: RuleEngine, u: DayUsage, z: ZonedDateTime, minutes: Int): DayUsage {
        val v = e.verdict("com.insta", e.snapshot(z, u), u)
        org.junit.Assert.assertTrue("kullanılabilmeli", v.allowed)
        return e.account(u, "com.insta", v, minutes * 60L)
    }

    private fun dayLeft(e: RuleEngine, z: ZonedDateTime, u: DayUsage = DayUsage(day)) = e.snapshot(z, u).let { it.dayLeftSeconds ?: it.remainingSeconds }

    @Test
    fun orbitDayChangesAtFive() {
        val e = RuleEngine(rules(emptyList()))
        assertEquals(day, e.logicalDay(at(4, 59, next)))
        assertEquals(next, e.logicalDay(at(5, 0, next)))
        assertEquals(day, e.logicalDay(at(23, 59)))
    }

    @Test
    fun timeGivenAfterMidnightWhileLockedShowsInLeftRing() {
        // 00:11'de kilitliyken 30 dk verildi (00:11–05:00): kullanılamaz ama hak olarak görünür
        val e = RuleEngine(rules(listOf(g("g30", 30, next, w("00:11", "05:00")))))
        val s = e.snapshot(at(0, 13, next), DayUsage(day))
        assertEquals(0L, s.remainingSeconds)
        assertEquals(30 * 60L, s.dayLeftSeconds)
    }

    @Test
    fun tomorrowsMorningGrantIsNotTonightsTime() {
        val e = RuleEngine(rules(listOf(g("g30", 30, next, w("00:11", "05:00")), g("g20", 20, next, w("06:40", "21:00")))))
        assertEquals(30 * 60L, dayLeft(e, at(0, 13, next)))
    }

    @Test
    fun eveningGrantCarriesOverMidnightWithoutDoubleCount() {
        // 22:46'da 28 dk: bugün 23:59'a kadar + ertesi gün 00:00–05:00 devam kaydı (aynı miktar)
        val e = RuleEngine(rules(listOf(g("a", 28, day, w("22:46", "23:59")), g("b", 28, next, w("00:00", "05:00")))))
        assertEquals(28 * 60L, dayLeft(e, at(23, 0)))
        assertEquals(28 * 60L, dayLeft(e, at(0, 30, next)))
    }

    @Test
    fun oldRangeGrantLeftoverStaysUntilDayEnd() {
        // Eski tip aralıklı süre (16:30–17:00, 40 dk): bölüm süresi bitince 10 dk'sı kullanıldı, kalan 30 dk 05:00'e kadar hakta
        val e = RuleEngine(rules(listOf(g("old", 40, day, w("16:30", "17:00")))))
        var u = use(e, DayUsage(day), at(16), 60)
        u = use(e, u, at(16, 40), 10)
        assertEquals(30 * 60L, e.snapshot(at(18), u).remainingSeconds)
        assertEquals(30 * 60L, dayLeft(e, at(23, 30), u))
        assertEquals(30 * 60L, dayLeft(e, at(0, 30, next), u))
    }

    @Test
    fun tempOpenGivesNoExtraTime() {
        // "Kilidi aç" aralığı süre değildir: dakikası ne olursa olsun hak değişmez
        val small = RuleEngine(rules(listOf(g("t", 1, day, w("21:30", "23:59"), "Geçici açma · Tam kilit"))))
        val big = RuleEngine(rules(listOf(g("t", 500, day, w("21:30", "23:59"), "Geçici açma · Tam kilit"))))
        assertEquals(dayLeft(small, at(22)), dayLeft(big, at(22)))
    }

    @Test
    fun givenTimeDoesNotDropWithClock() {
        val e = RuleEngine(rules(listOf(g("g", 30, day, w("16:00", "23:59")))))
        val a = e.snapshot(at(16, 30), DayUsage(day)).remainingSeconds
        val b = e.snapshot(at(18, 30), DayUsage(day)).remainingSeconds
        assertEquals(a, b)
        // Kilitli Uyku bölümünde de aynı 30 dk hak olarak görünür (bölüm süresi hariç)
        assertEquals(30 * 60L, dayLeft(e, at(22)))
    }

    @Test
    fun nightReductionDoesNotEatTomorrowsTime() {
        // 01:28'de 48 dk düşüldü (önceki Orbit günü); 16:28'de görevden 30 dk kazanıldı: 30 dk görünmeli
        val cut = Command("c", CommandType.ADJUST, at(1, 28, next).toInstant().toEpochMilli(), null, null, -48, false, false)
        val e = RuleEngine(rules(listOf(g("t30", 30, next, w("16:28", "23:59")))).copy(commands = listOf(cut)))
        assertEquals(30 * 60L, dayLeft(e, at(22, 0, next), DayUsage(next)))
    }
}
