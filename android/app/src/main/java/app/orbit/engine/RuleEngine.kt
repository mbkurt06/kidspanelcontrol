package app.orbit.engine

import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

/** Bir uygulamanın şu anki durumu ve kullanılırsa hangi sayaçlardan düşeceği. */
data class AppVerdict(
    val allowed: Boolean,
    /** Kapalıysa çocuğa gösterilecek neden */
    val reason: String? = null,
    /** Kullanılırsa günlük süreden düşsün mü */
    val countsDaily: Boolean = false,
    /** Kullanılırsa hangi durumun süresinden düşsün */
    val countsMode: String? = null,
)

/** Belirli bir an için hesaplanmış tablo. */
data class Snapshot(
    val day: LocalDate,
    val now: LocalTime,
    val profile: Profile,
    val activeMode: Mode?,
    val modeIsManual: Boolean,
    val modeEndsAt: LocalTime?,
    val locked: Boolean,
    val lockUntil: Long?,
    val free: Boolean,
    /** Bugünkü toplam hak (dakika): profil + ekstra + düzeltmeler, üst sınırla */
    val allowanceMinutes: Int,
    val usedMinutes: Int,
    val remainingSeconds: Long,
    val modeRemainingSeconds: Long?,
    val extraMinutesToday: Int,
    /** Çocuğun kullanabileceği, bekleyen ekstra süreler */
    val walletGrants: List<Grant>,
)

/**
 * Kural motoru — telefonun "ne açık, ne kapalı" kararını verir. Tamamen saf, test edilebilir.
 *
 * Sıra:
 * 1. Her zaman açık + onaylı uygulama hep açıktır.
 * 2. Ebeveyn "serbest" verdiyse onaylı her şey açık; "kilitle" dediyse sadece her zaman açık olanlar.
 * 3. Aktif bir durum (elle başlatılan veya programdaki en yüksek öncelikli) varsa:
 *    durumdaki uygulamalar durum süresi bitene kadar açık; durum dışı uygulamalar "diğerleri kapalı" ise kapalı.
 * 4. Normal kurallar: sınırsız → izinli saatlerde; süreli → izinli saatlerde ve günlük süre kaldıkça.
 */
class RuleEngine(private val rules: Rules) {

    private val zone: ZoneId = runCatching { ZoneId.of(rules.timezone) }.getOrDefault(ZoneId.of("Europe/Berlin"))

    companion object {
        val FALLBACK_PROFILE = Profile("fallback", "Varsayılan", 60, null, emptyList(), emptyList(), listOf(10, 2))
    }

    fun zone(): ZoneId = zone

    fun profileFor(day: LocalDate): Profile {
        val ov = rules.overrides.firstOrNull { it.day == day }
        val base = ov?.profileId?.let { rules.profiles[it] }
            ?: rules.assignments[day.dayOfWeek.value]?.let { rules.profiles[it] }
            ?: FALLBACK_PROFILE
        return if (ov?.dailyMinutes != null) base.copy(dailyMinutes = ov.dailyMinutes) else base
    }

    /** Lock/unlock: en son verilen komut geçerlidir (süresi dolmadıysa). */
    private fun lockState(nowMs: Long): Triple<Boolean, Boolean, Long?> {
        val last = rules.commands
            .filter { !it.cancelled && (it.type == CommandType.LOCK || it.type == CommandType.UNLOCK) }
            .maxByOrNull { it.createdAt } ?: return Triple(false, false, null)
        val live = last.untilAt == null || last.untilAt > nowMs
        return when {
            last.type == CommandType.LOCK && live -> Triple(true, false, last.untilAt)
            last.type == CommandType.UNLOCK && last.free && last.untilAt != null && live -> Triple(false, true, last.untilAt)
            else -> Triple(false, false, null)
        }
    }

    private fun manualMode(nowMs: Long): Pair<Mode, Long?>? {
        val last = rules.commands
            .filter { !it.cancelled && (it.type == CommandType.START_MODE || it.type == CommandType.END_MODE) }
            .maxByOrNull { it.createdAt } ?: return null
        if (last.type != CommandType.START_MODE) return null
        if (last.untilAt != null && last.untilAt <= nowMs) return null
        val m = rules.modes[last.modeId] ?: return null
        return m to last.untilAt
    }

    /** Programdaki aktif durumlar: bugünün profili + gece yarısını geçen dünkü aralıklar. */
    private fun scheduledModes(day: LocalDate, t: LocalTime): List<Pair<Mode, LocalTime>> {
        val today = profileFor(day).id
        val yesterday = profileFor(day.minusDays(1)).id
        val dow = day.dayOfWeek.value
        val ydow = day.minusDays(1).dayOfWeek.value
        val out = mutableListOf<Pair<Mode, LocalTime>>()
        for (s in rules.slots) {
            val m = rules.modes[s.modeId] ?: continue
            val crosses = s.start > s.end
            if (s.profileId == today && dow in s.days) {
                if (!crosses && t >= s.start && t < s.end) out += m to s.end
                if (crosses && t >= s.start) out += m to s.end
            }
            if (crosses && s.profileId == yesterday && ydow in s.days && t < s.end) out += m to s.end
        }
        return out
    }

    fun extraMinutes(day: LocalDate, dayStartMs: Long, dayEndMs: Long): Int {
        val grants = rules.grants.filter { it.validOn == day || it.activatedOn == day }.sumOf { it.minutes }
        val adjust = rules.commands
            .filter { !it.cancelled && it.type == CommandType.ADJUST && it.createdAt in dayStartMs until dayEndMs }
            .sumOf { it.minutes ?: 0 }
        return grants + adjust
    }

    fun snapshot(nowZ: ZonedDateTime, usage: DayUsage): Snapshot {
        val now = nowZ.withZoneSameInstant(zone)
        val day = now.toLocalDate()
        val t = now.toLocalTime()
        val nowMs = now.toInstant().toEpochMilli()
        val dayStart = day.atStartOfDay(zone).toInstant().toEpochMilli()
        val dayEnd = day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()

        val profile = profileFor(day)
        val (locked, free, lockUntil) = lockState(nowMs)
        val manual = manualMode(nowMs)
        val sched = scheduledModes(day, t).maxByOrNull { it.first.priority }
        val active = manual?.first ?: sched?.first
        val modeEnds = if (manual != null) manual.second?.let { java.time.Instant.ofEpochMilli(it).atZone(zone).toLocalTime() } else sched?.second

        val extra = extraMinutes(day, dayStart, dayEnd)
        var allowance = (profile.dailyMinutes + extra).coerceAtLeast(0)
        profile.maxTotalMinutes?.let { allowance = minOf(allowance, it) }
        val used = usage.countedSeconds
        val remaining = (allowance * 60L - used).coerceAtLeast(0)
        val modeRemaining = active?.budgetMinutes?.let { (it * 60L - (usage.perMode[active.id] ?: 0)).coerceAtLeast(0) }

        val wallet = rules.grants.filter {
            it.validOn == null && it.activatedOn == null && (it.expiresOn == null || !it.expiresOn.isBefore(day))
        }

        return Snapshot(
            day = day, now = t, profile = profile, activeMode = active, modeIsManual = manual != null,
            modeEndsAt = modeEnds, locked = locked, lockUntil = lockUntil, free = free,
            allowanceMinutes = allowance, usedMinutes = (used / 60).toInt(), remainingSeconds = remaining,
            modeRemainingSeconds = modeRemaining, extraMinutesToday = extra, walletGrants = wallet,
        )
    }

    private fun inWindows(ws: List<TimeWindow>, t: LocalTime) = ws.isEmpty() || ws.any { it.contains(t) }

    fun verdict(pkg: String, s: Snapshot, usage: DayUsage): AppVerdict {
        val app = rules.apps[pkg]
        val group = app?.group ?: Group.BLOCKED
        val approved = app?.approved == true

        if (approved && group == Group.ALWAYS_OPEN) return AppVerdict(true)
        if (s.free) {
            return if (approved && group != Group.BLOCKED) AppVerdict(true) else AppVerdict(false, if (!approved) "Ebeveyn onayı bekliyor" else "Bu uygulama kapalı")
        }
        if (s.locked) return AppVerdict(false, "Telefon ebeveyn tarafından kilitlendi")

        val mode = s.activeMode
        if (mode != null) {
            val inMode = pkg in mode.allowedPackages || (approved && group in mode.allowedGroups && group != Group.BLOCKED)
            if (inMode) {
                val budgetLeft = s.modeRemainingSeconds?.let { it > 0 } ?: true
                if (budgetLeft) {
                    val countsDaily = mode.countsTowardDaily && group != Group.UNLIMITED
                    if (countsDaily && s.remainingSeconds <= 0) return AppVerdict(false, "Günlük süren bitti")
                    return AppVerdict(true, countsDaily = countsDaily, countsMode = if (mode.budgetMinutes != null) mode.id else null)
                }
                if (mode.othersBlocked) return AppVerdict(false, "${mode.name} süresi bitti")
            } else if (mode.othersBlocked) {
                return AppVerdict(false, "Şu an ${mode.name}")
            }
        }

        if (!approved) return AppVerdict(false, "Ebeveyn onayı bekliyor")
        return when (group) {
            Group.ALWAYS_OPEN -> AppVerdict(true)
            Group.BLOCKED -> AppVerdict(false, "Bu uygulama kapalı")
            Group.UNLIMITED ->
                if (inWindows(s.profile.unlimitedWindows, s.now)) AppVerdict(true)
                else AppVerdict(false, "Bu saatlerde kapalı")
            Group.TIMED -> {
                if (!inWindows(s.profile.timedWindows, s.now)) return AppVerdict(false, "Bu saatlerde kapalı")
                if (s.remainingSeconds <= 0) return AppVerdict(false, "Günlük süren bitti")
                val limit = app?.dailyLimitMinutes
                if (limit != null && (usage.perAppCounted[pkg] ?: 0) >= limit * 60L) return AppVerdict(false, "Bu uygulamanın günlük sınırı doldu")
                AppVerdict(true, countsDaily = true)
            }
        }
    }

    /** Ön planda geçen süreyi sayaçlara ekler. */
    fun account(usage: DayUsage, pkg: String, v: AppVerdict, seconds: Long): DayUsage {
        if (seconds <= 0) return usage
        var u = usage.copy(perAppTotal = usage.perAppTotal + (pkg to ((usage.perAppTotal[pkg] ?: 0) + seconds)))
        if (v.allowed && v.countsDaily) {
            u = u.copy(
                countedSeconds = u.countedSeconds + seconds,
                perAppCounted = u.perAppCounted + (pkg to ((u.perAppCounted[pkg] ?: 0) + seconds)),
            )
        }
        if (v.allowed && v.countsMode != null) {
            u = u.copy(perMode = u.perMode + (v.countsMode to ((u.perMode[v.countsMode] ?: 0) + seconds)))
        }
        return u
    }

    /** Gösterilecek uyarılar: süre bitmeden X dk önce ve durum değişmeden önce. */
    fun dueWarnings(s: Snapshot, usage: DayUsage): List<Pair<String, String>> {
        val out = mutableListOf<Pair<String, String>>()
        val remMin = s.remainingSeconds / 60.0
        for (w in s.profile.warnMinutes.sortedDescending()) {
            val key = "daily-$w-${s.allowanceMinutes}"
            if (s.remainingSeconds > 0 && remMin <= w && key !in usage.warned) {
                out += key to "Günlük sürenin bitmesine $w dakika kaldı"
            }
        }
        val m = s.activeMode
        if (m != null && s.modeRemainingSeconds != null) {
            for (w in m.warnMinutes) {
                val key = "mode-${m.id}-$w"
                if (s.modeRemainingSeconds > 0 && s.modeRemainingSeconds / 60.0 <= w && key !in usage.warned) {
                    out += key to "${m.name} süresinin bitmesine $w dakika kaldı"
                }
            }
        }
        if (m != null && s.modeEndsAt != null) {
            val mins = java.time.Duration.between(s.now, s.modeEndsAt).toMinutes().let { if (it < 0) it + 1440 else it }
            for (w in m.warnMinutes) {
                val key = "modeend-${m.id}-${s.modeEndsAt}-$w"
                if (mins in 0..w.toLong() && key !in usage.warned) out += key to "${m.name} $w dakika içinde bitiyor"
            }
        }
        return out
    }
}
