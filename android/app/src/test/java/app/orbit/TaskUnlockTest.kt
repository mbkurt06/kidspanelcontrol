package app.orbit

import app.orbit.engine.AppRule
import app.orbit.engine.DayUsage
import app.orbit.engine.Grant
import app.orbit.engine.Group
import app.orbit.engine.Profile
import app.orbit.engine.RuleEngine
import app.orbit.engine.Rules
import app.orbit.engine.SecRule
import app.orbit.engine.Section
import app.orbit.engine.TaskRestriction
import app.orbit.engine.TimeWindow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

/** Görev kilidi (K0–K3): kazanılan süre diğer görevlerin "Önce görev" kilidini ne zamana kadar kaldırır */
class TaskUnlockTest {
    private val zone = ZoneId.of("Europe/Berlin")
    private val day = LocalDate.of(2026, 10, 21)
    private fun at(h: Int, m: Int = 0) = ZonedDateTime.of(day, LocalTime.of(h, m), zone)
    private fun t(s: String) = LocalTime.parse(s)
    private val t0 = at(8).toInstant().toEpochMilli()

    private val sections = listOf(
        Section("serbest", "p1", "Serbest", t("08:00"), t("21:00"), 120, true, SecRule.TIMED, 0),
        Section("uyku", "p1", "Uyku", t("21:00"), t("08:00"), null, false, SecRule.BLOCKED, 1),
    )

    // Grupta zorunlu "Ders Çalış" kilidi (kiosk), yapılmadı
    private val lock = TaskRestriction("Ders Çalış", "open", "kiosk", emptySet(), runId = "rDers", createdAtMs = t0, groupId = "grp")

    private fun rules(grants: List<Grant>) = Rules(
        apps = mapOf("com.insta" to AppRule("com.insta", "Insta", Group.TIMED, true, null)),
        profiles = mapOf("p1" to Profile("p1", "Hafta içi", 0, null, emptyList(), emptyList(), listOf(10, 2))),
        assignments = (1..7).associateWith { "p1" },
        grants = grants,
        sections = sections,
        taskRestrictions = listOf(lock),
        taskRunGroups = mapOf("rOda" to "grp", "rDers" to "grp"),
    )

    // 16:20'de onaylanan görevin 30 dk ödülü (gün sonuna kadar)
    private fun reward(id: String, run: String, unlock: String?, until: String? = null) = Grant(
        id, 30, day, null, null, id, window = TimeWindow(t("16:20"), t("23:59")), toVault = true, source = "task",
        createdAtMs = at(16, 20).toInstant().toEpochMilli(), taskRunId = run, unlock = unlock, unlockUntil = until?.let { t(it) },
    )

    private fun locked(e: RuleEngine, h: Int, m: Int = 0, usedMin: Long = 0, id: String = "g") =
        e.also { it.refreshSpent(DayUsage(day, buckets = mapOf("w:$id" to usedMin * 60)), day) }.taskRestrictionNow(day, LocalTime.of(h, m))

    @Test
    fun k1_standaloneTaskOpensPhoneUntilItsTimeIsUsed() {
        // Ayşe'nin durumu: grup dışı görev (grubu yok) K1 → Ders Çalış kilidi süresi boyunca kalkar
        val e = RuleEngine(rules(listOf(reward("g", "rElma", "k1"))))
        assertNull("süresi varken açık", locked(e, 17, 0, usedMin = 10))
        assertNull("parça parça, akşam da açık", locked(e, 20, 30, usedMin = 29))
        assertNotNull("süre bitince kilit geri gelir", locked(e, 20, 40, usedMin = 30))
    }

    @Test
    fun k0_doesNotOpenPhone() {
        val e = RuleEngine(rules(listOf(reward("g", "rElma", "k0"))))
        assertNotNull(locked(e, 17))
    }

    @Test
    fun k2_opensForTheRestOfTheDayEvenWhenTimeIsUsed() {
        val e = RuleEngine(rules(listOf(reward("g", "rElma", "k2"))))
        assertNull(locked(e, 17, usedMin = 30))
        assertNull(locked(e, 20, 50, usedMin = 30))
    }

    @Test
    fun k3_opensUntilChosenHour() {
        val e = RuleEngine(rules(listOf(reward("g", "rElma", "k3", "20:00"))))
        assertNull(locked(e, 19, 59, usedMin = 30))
        assertNotNull(locked(e, 20, 0))
    }

    @Test
    fun oldGroupGrantsStillLiftSameGroupOnly() {
        // Eski kayıt (ayar yok): aynı grubun görev süresi kaldırır, grup dışı görev kaldırmaz
        val same = RuleEngine(rules(listOf(reward("g", "rOda", null))))
        assertNull(locked(same, 17))
        val other = RuleEngine(rules(listOf(reward("g", "rElma", null))))
        assertNotNull(locked(other, 17))
    }

    @Test
    fun twoK1RewardsAddUp() {
        // Odanı topla 30 + Elma 30 (ikisi K1): ikisi de bitene kadar açık
        val e = RuleEngine(rules(listOf(reward("a", "rOda", "k1"), reward("b", "rElma", "k1"))))
        e.refreshSpent(DayUsage(day, buckets = mapOf("w:a" to 30 * 60L, "w:b" to 10 * 60L)), day)
        assertEquals(null, e.taskRestrictionNow(day, LocalTime.of(18, 0)))
        e.refreshSpent(DayUsage(day, buckets = mapOf("w:a" to 30 * 60L, "w:b" to 30 * 60L)), day)
        assertNotNull(e.taskRestrictionNow(day, LocalTime.of(18, 0)))
    }
}
