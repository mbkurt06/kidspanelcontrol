package app.orbit

import app.orbit.engine.AppRule
import app.orbit.engine.AppVerdict
import app.orbit.engine.DayUsage
import app.orbit.engine.Grant
import app.orbit.engine.Group
import app.orbit.engine.Profile
import app.orbit.engine.RuleEngine
import app.orbit.engine.Rules
import app.orbit.engine.SecRule
import app.orbit.engine.Section
import app.orbit.engine.SectionRule
import app.orbit.engine.UNLIMITED_SECONDS
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

/** Gün bölümleri + uygulama grupları kural motoru. */
class SectionEngineTest {
    private val zone = ZoneId.of("Europe/Berlin")
    private val day = LocalDate.of(2026, 10, 21) // Çarşamba
    private fun at(h: Int, m: Int = 0, d: LocalDate = day) = ZonedDateTime.of(d, LocalTime.of(h, m), zone)
    private fun t(s: String) = LocalTime.parse(s)

    private fun profile(cap: Int? = null) = Profile("p1", "Hafta içi", 90, cap, emptyList(), emptyList(), listOf(10, 2))

    private val sections = listOf(
        Section("sabah", "p1", "Sabah", t("07:00"), t("08:00"), 15, false, SecRule.BLOCKED, 0),
        Section("okul", "p1", "Okul", t("08:00"), t("14:00"), null, false, SecRule.BLOCKED, 1),
        Section("serbest", "p1", "Serbest", t("16:00"), t("19:00"), 60, true, SecRule.TIMED, 2),
        Section("aksam", "p1", "Akşam", t("19:00"), t("21:00"), 30, false, SecRule.TIMED, 3),
        Section("uyku", "p1", "Uyku", t("21:00"), t("07:00"), null, false, SecRule.BLOCKED, 4),
    )

    private val sectionRules = listOf(
        SectionRule("sabah", "g-video", null, SecRule.TIMED, null),
        SectionRule("sabah", null, "com.wa", SecRule.OPEN, null),
        SectionRule("okul", null, "com.edu", SecRule.OPEN, null),
        SectionRule("serbest", "g-game", null, SecRule.TIMED, 30),
        SectionRule("serbest", "g-video", null, SecRule.TIMED, 20),
        SectionRule("aksam", "g-game", null, SecRule.BLOCKED, null),
    )

    private val apps = listOf(
        AppRule("com.phone", "Telefon", Group.ALWAYS_OPEN, true, null),
        AppRule("com.game1", "Oyun 1", Group.TIMED, true, null),
        AppRule("com.game2", "Oyun 2", Group.TIMED, true, null),
        AppRule("com.yt", "YouTube", Group.TIMED, true, null),
        AppRule("com.edu", "Khan", Group.TIMED, true, null),
        AppRule("com.wa", "WhatsApp", Group.TIMED, true, null),
        AppRule("com.insta", "Insta", Group.TIMED, true, null),
        AppRule("com.never", "Kapalı", Group.BLOCKED, true, null),
        AppRule("com.new", "Yeni", Group.BLOCKED, false, null),
    ).associateBy { it.pkg }

    private fun rules(cap: Int? = null, grants: List<Grant> = emptyList(), gameDaily: Int? = null) = Rules(
        apps = apps,
        profiles = mapOf("p1" to profile(cap)),
        assignments = (1..7).associateWith { "p1" },
        grants = grants,
        sections = sections,
        sectionRules = sectionRules,
        groupOf = mapOf("com.game1" to "g-game", "com.game2" to "g-game", "com.yt" to "g-video", "com.edu" to "g-video"),
        groupNames = mapOf("g-game" to "Oyunlar", "g-video" to "Video"),
        groupLimits = if (gameDaily != null) mapOf("p1" to mapOf("g-game" to gameDaily)) else emptyMap(),
    )

    private fun use(e: RuleEngine, u: DayUsage, pkg: String, z: ZonedDateTime, minutes: Int): DayUsage {
        val v = e.verdict(pkg, e.snapshot(z, u), u)
        assertTrue("$pkg kullanılabilmeli", v.allowed)
        return e.account(u, pkg, v, minutes * 60L)
    }

    private fun v(e: RuleEngine, pkg: String, z: ZonedDateTime, u: DayUsage = DayUsage(day)): AppVerdict = e.verdict(pkg, e.snapshot(z, u), u)

    @Test
    fun findsSectionsGapsAndNightSpill() {
        val e = RuleEngine(rules())
        val s = e.snapshot(at(16, 30), DayUsage(day))
        assertTrue(s.sectionMode)
        assertEquals("Serbest", s.section?.section?.name)
        assertEquals(t("19:00"), s.section?.endsAt)
        // 14–16 arası bölüm yok: kapalı
        assertNull(e.snapshot(at(15), DayUsage(day)).section)
        assertEquals("Bu saatlerde kapalı", v(e, "com.insta", at(15)).reason)
        // Gece 06:30: dünün Uyku bölümü
        val night = e.snapshot(at(6, 30), DayUsage(day))
        assertEquals("Uyku", night.section?.section?.name)
        assertEquals(day.minusDays(1), night.section?.startDay)
        assertFalse(v(e, "com.insta", at(6, 30)).allowed)
        // Her zaman açık uygulama uykuda da açık
        assertTrue(v(e, "com.phone", at(23)).allowed)
    }

    @Test
    fun ruleResolutionAppOverridesGroupOverridesDefault() {
        val e = RuleEngine(rules())
        // Okul: varsayılan kapalı, ama Khan (Video grubunda) için istisna açık
        assertTrue(v(e, "com.edu", at(10)).allowed)
        assertFalse(v(e, "com.edu", at(10)).countsDaily)
        assertFalse(v(e, "com.yt", at(10)).allowed)
        // Sabah: Video süreli, WhatsApp açık, gruba girmemiş Insta varsayılan (kapalı)
        assertTrue(v(e, "com.yt", at(7, 30)).countsDaily)
        assertTrue(v(e, "com.wa", at(7, 30)).allowed)
        assertFalse(v(e, "com.wa", at(7, 30)).countsDaily)
        assertFalse(v(e, "com.insta", at(7, 30)).allowed)
        // Akşam oyunlar kapalı, gruba girmemiş Insta süreli (varsayılan)
        assertFalse(v(e, "com.game1", at(19, 30)).allowed)
        assertTrue(v(e, "com.insta", at(19, 30)).countsDaily)
        // Onaysız ve "hep kapalı" uygulamalar her bölümde kapalı
        assertEquals("Ebeveyn onayı bekliyor", v(e, "com.new", at(17)).reason)
        assertFalse(v(e, "com.never", at(17)).allowed)
    }

    @Test
    fun groupLimitInsideSectionAndSectionBudget() {
        val e = RuleEngine(rules())
        var u = DayUsage(day)
        u = use(e, u, "com.game1", at(16, 10), 20)
        u = use(e, u, "com.game2", at(16, 30), 10)
        // Oyunlar Serbest'te 30 dk: doldu (iki oyun birlikte)
        assertEquals("Oyunlar için Serbest süresi doldu", v(e, "com.game1", at(16, 45), u).reason)
        // Video'nun kendi 20 dk'sı var, bölümde 30 dk kaldı
        val s = e.snapshot(at(16, 45), u)
        assertEquals(30 * 60L, s.sectionLeftSeconds)
        u = use(e, u, "com.yt", at(16, 45), 20)
        assertFalse(v(e, "com.yt", at(17, 10), u).allowed)
        u = use(e, u, "com.insta", at(17, 10), 10)
        // Bölüm süresi (60) bitti
        val end = e.snapshot(at(17, 30), u)
        assertEquals(0L, end.remainingSeconds)
        assertEquals("Serbest süren bitti", v(e, "com.insta", at(17, 30), u).reason)
    }

    @Test
    fun carryOverToNextSection() {
        val e = RuleEngine(rules())
        var u = DayUsage(day)
        u = use(e, u, "com.insta", at(16, 10), 20)
        // Serbest 40 dk artık → devreder: Akşam 30 + 40 = 70
        assertEquals(70 * 60L, e.snapshot(at(19, 30), u).sectionLeftSeconds)
        // Sabah'ın artığı devretmez (carry kapalı)
        val e2 = RuleEngine(rules())
        assertEquals(60 * 60L, e2.snapshot(at(16, 5), DayUsage(day)).sectionLeftSeconds)
    }

    @Test
    fun poolAndSectionGrants() {
        val pool = Grant("g1", 15, day, null, null, "ödül", null)
        val toSerbest = Grant("g2", 10, day, null, null, "ödül", "serbest")
        val e = RuleEngine(rules(grants = listOf(pool, toSerbest)))
        val s = e.snapshot(at(16, 5), DayUsage(day))
        assertEquals(70 * 60L, s.sectionLeftSeconds)
        assertEquals(15 * 60L, s.poolLeftSeconds)
        assertEquals(85 * 60L, s.remainingSeconds)
        var u = DayUsage(day)
        u = use(e, u, "com.insta", at(16, 10), 80)
        val after = e.snapshot(at(17, 40), u)
        assertEquals(0L, after.sectionLeftSeconds)
        assertEquals(5 * 60L, after.poolLeftSeconds)
        assertTrue(v(e, "com.insta", at(17, 40), u).allowed)
        // Havuz Akşam'da da kullanılabilir (Akşam 30 + havuz 5)
        assertEquals(35 * 60L, e.snapshot(at(19, 30), u).remainingSeconds)
    }

    @Test
    fun dailyCapAndGroupDailyLimit() {
        val e = RuleEngine(rules(cap = 50))
        var u = DayUsage(day)
        u = use(e, u, "com.yt", at(7, 10), 15)
        // Gün sınırı 50: 35 dk kaldı, Serbest 60 olsa da
        val s = e.snapshot(at(16, 5), u)
        assertEquals(35 * 60L, s.remainingSeconds)
        assertEquals(35 * 60L, s.capLeftSeconds)

        val e2 = RuleEngine(rules(gameDaily = 25))
        var u2 = DayUsage(day)
        u2 = use(e2, u2, "com.game1", at(16, 5), 25)
        assertEquals("Oyunlar için bugünkü süre doldu", v(e2, "com.game2", at(16, 40), u2).reason)
    }

    @Test
    fun noBudgetAndNoCapMeansUnlimited() {
        val open = Section("all", "p1", "Gün", t("07:00"), t("22:00"), null, false, SecRule.TIMED, 0)
        val e = RuleEngine(rules().copy(sections = listOf(open), sectionRules = emptyList()))
        val s = e.snapshot(at(12), DayUsage(day))
        assertEquals(UNLIMITED_SECONDS, s.remainingSeconds)
        assertTrue(v(e, "com.insta", at(12)).allowed)
    }

    @Test
    fun usageBucketsSurviveJsonRoundTrip() {
        val e = RuleEngine(rules())
        val u = use(e, DayUsage(day), "com.game1", at(16, 10), 5)
        val back = app.orbit.data.Parse.usageFromJson(app.orbit.data.Parse.usageToJson(u))
        assertEquals(u.buckets, back.buckets)
        assertEquals(300L, back.buckets["sg:serbest@$day|g-game"])
    }
}
