package app.orbit

import app.orbit.engine.AppRule
import app.orbit.engine.DayUsage
import app.orbit.engine.Group
import app.orbit.engine.Profile
import app.orbit.engine.RuleEngine
import app.orbit.engine.Rules
import app.orbit.engine.SecRule
import app.orbit.engine.Section
import app.orbit.engine.TimeWindow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

/** Kiosk uygulaması: kilitliyken (kapalı saat) de açık, saat aralığı dışında kilitliyken kapalı, süreden düşmez */
class KioskAppTest {
    private val zone = ZoneId.of("Europe/Berlin")
    private val day = LocalDate.of(2026, 10, 21)
    private fun at(h: Int, m: Int = 0) = ZonedDateTime.of(day, LocalTime.of(h, m), zone)
    private fun t(s: String) = LocalTime.parse(s)

    private val sections = listOf(
        Section("serbest", "p1", "Serbest", t("08:00"), t("21:00"), 120, true, SecRule.TIMED, 0),
        Section("uyku", "p1", "Uyku", t("21:00"), t("08:00"), null, false, SecRule.BLOCKED, 1),
    )

    private val rules = Rules(
        apps = mapOf(
            "com.insta" to AppRule("com.insta", "Insta", Group.TIMED, true, null),
            "com.quran" to AppRule("com.quran", "Kuran", Group.ALWAYS_OPEN, true, null, kiosk = true),
            "com.duo" to AppRule("com.duo", "Duolingo", Group.ALWAYS_OPEN, true, null, kiosk = true,
                kioskWindows = listOf(TimeWindow(t("07:00"), t("22:00")))),
        ),
        profiles = mapOf("p1" to Profile("p1", "Hafta içi", 0, null, emptyList(), emptyList(), listOf(10, 2))),
        assignments = (1..7).associateWith { "p1" },
        sections = sections,
    )

    private fun v(e: RuleEngine, pkg: String, h: Int, m: Int = 0) = DayUsage(day).let { u -> e.verdict(pkg, e.snapshot(at(h, m), u), u) }

    @Test
    fun kioskAppOpenInClosedHoursAndNeverCounts() {
        val e = RuleEngine(rules)
        assertFalse(v(e, "com.insta", 21, 30).allowed)
        val q = v(e, "com.quran", 21, 30)
        assertTrue(q.allowed)
        assertFalse(q.countsDaily)
        assertTrue(v(e, "com.duo", 21, 30).allowed)
    }

    @Test
    fun outsideItsWindowClosedWhileLocked() {
        val e = RuleEngine(rules)
        assertFalse("22:00 sonrası uyku saatinde kapalı", v(e, "com.duo", 23).allowed)
        assertTrue("saatsiz kiosk her zaman açık", v(e, "com.quran", 23).allowed)
        assertEquals(listOf("com.quran"), e.kioskApps(t("23:00")).map { it.pkg })
        assertEquals(listOf("com.duo", "com.quran"), e.kioskApps(t("12:00")).map { it.pkg })
    }
}
