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
    /** Kullanılırsa artacak bölüm/grup sayaçları */
    val buckets: List<String> = emptyList(),
)

/** O an geçerli bölüm (bugünün ya da gece yarısını geçen dünkü bölümün) örneği. */
data class SectionNow(
    val section: Section,
    /** Bölümün başladığı gün (sayaç anahtarı için) */
    val startDay: LocalDate,
    val endsAt: LocalTime,
) {
    val key get() = "${section.id}@$startDay"
}

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
    /** Ebeveyn modu: ebeveyn telefonda işlem yapıyor, bütün sınırlamalar kalktı */
    val parentMode: Boolean = false,
    val parentModeUntil: Long? = null,
    /** Bugünün gün tipinde bölüm var mı (yeni kural motoru) */
    val sectionMode: Boolean = false,
    /** Şu anki bölüm (bölümler arası boşlukta null) */
    val section: SectionNow? = null,
    /** Bölümde kalan (bölüm süresi + devreden + bölüme verilen ekstra); bölüm süresi yoksa null */
    val sectionLeftSeconds: Long? = null,
    /** Gün boyu havuzda kalan ekstra süre */
    val poolLeftSeconds: Long = 0,
    /** Günlük üst sınırdan kalan; sınır yoksa null */
    val capLeftSeconds: Long? = null,
    /** Bölümde açık ya da süreli hiçbir şey yok (Uyku / Kapalı gibi) */
    val sectionClosed: Boolean = false,
)

/** "Sınırsız" kalan süre (bölüm süresi ve günlük sınır yok) */
const val UNLIMITED_SECONDS = 24 * 3600L

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

    /** Ebeveyn modu: iptal edilmemiş, süresi dolmamış "bakım" komutu varsa. En geç biteni döner. */
    fun parentModeUntil(nowMs: Long): Long? = rules.commands
        .filter { it.type == CommandType.RESYNC && it.maintenance && !it.cancelled && (it.untilAt ?: 0) > nowMs }
        .maxOfOrNull { it.untilAt!! }

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
        val grants = rules.grants.filter { !it.vault && it.window == null && (it.validOn == day || it.activatedOn == day) }.sumOf { it.minutes }
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

        val parentUntil = parentModeUntil(nowMs)
        val extra = extraMinutes(day, dayStart, dayEnd)
        var allowance = (profile.dailyMinutes + extra).coerceAtLeast(0)
        profile.maxTotalMinutes?.let { allowance = minOf(allowance, it) }
        val used = usage.countedSeconds
        val remaining = (allowance * 60L - used).coerceAtLeast(0)
        val modeRemaining = active?.budgetMinutes?.let { (it * 60L - (usage.perMode[active.id] ?: 0)).coerceAtLeast(0) }

        val wallet = rules.grants.filter {
            !it.vault && it.validOn == null && it.activatedOn == null && (it.expiresOn == null || !it.expiresOn.isBefore(day))
        }

        val todaySections = rules.sections.filter { it.profileId == profile.id }
        if (todaySections.isNotEmpty()) {
            return sectionSnapshot(
                now, day, t, profile, todaySections, usage, dayStart, dayEnd, wallet,
                manual, active, modeEnds, modeRemaining, locked, lockUntil, free, parentUntil,
            )
        }

        return Snapshot(
            day = day, now = t, profile = profile, activeMode = active, modeIsManual = manual != null,
            modeEndsAt = modeEnds, locked = locked, lockUntil = lockUntil, free = free,
            allowanceMinutes = allowance, usedMinutes = (used / 60).toInt(), remainingSeconds = remaining,
            modeRemainingSeconds = modeRemaining, extraMinutesToday = extra, walletGrants = wallet,
            parentMode = parentUntil != null, parentModeUntil = parentUntil,
        )
    }

    // --- Bölümler ---

    /** Şu anki bölüm: bugünün bölümleri önce; yoksa dünden taşan (gece yarısını geçen) bölüm. */
    /** Ebeveynin belirli saat aralığına verdiği ekstra süre o an geçerliyse, o aralık sanal bir bölüm olur. */
    fun windowSection(day: LocalDate, t: LocalTime): SectionNow? {
        val g = rules.grants.firstOrNull { !it.vault && it.validOn == day && it.window?.contains(t) == true } ?: return null
        val w = g.window!!
        val sec = Section(
            "grant:${g.id}", profileFor(day).id, g.note?.takeIf { it.isNotBlank() } ?: "Ekstra süre",
            w.start, w.end, g.minutes, false, SecRule.TIMED, 0, "🎁", "Ebeveynin verdiği ekstra süre",
        )
        return SectionNow(sec, day, w.end)
    }

    /** Bugünün bölümleri (saat sırasıyla) — çocuğun "Günüm" ekranı için. */
    fun daySections(day: LocalDate): List<Section> =
        rules.sections.filter { it.profileId == profileFor(day).id }.sortedWith(compareBy({ it.start }, { it.order }))

    /** Bugün için saat aralıklı ekstra süreler. */
    fun dayWindows(day: LocalDate): List<Grant> = rules.grants.filter { !it.vault && it.validOn == day && it.window != null }

    fun currentSection(day: LocalDate, t: LocalTime): SectionNow? {
        windowSection(day, t)?.let { return it }
        val today = profileFor(day).id
        val todays = rules.sections.filter { it.profileId == today }
        todays.firstOrNull { !it.crossesMidnight && t >= it.start && t < it.end }?.let { return SectionNow(it, day, it.end) }
        todays.firstOrNull { it.crossesMidnight && t >= it.start }?.let { return SectionNow(it, day, it.end) }
        val yesterday = profileFor(day.minusDays(1)).id
        rules.sections.firstOrNull { it.profileId == yesterday && it.crossesMidnight && t < it.end }
            ?.let { return SectionNow(it, day.minusDays(1), it.end) }
        // Dünkü gün tipinde bölüm yoksa bugünün gece bölümü sabahı da kapsar
        if (rules.sections.none { it.profileId == yesterday }) {
            todays.firstOrNull { it.crossesMidnight && t < it.end }?.let { return SectionNow(it, day.minusDays(1), it.end) }
        }
        return null
    }

    private fun bucket(usage: DayUsage, k: String) = usage.buckets[k] ?: 0L

    private fun sectionSnapshot(
        now: ZonedDateTime, day: LocalDate, t: LocalTime, profile: Profile, todaySections: List<Section>, usage: DayUsage,
        dayStart: Long, dayEnd: Long, wallet: List<Grant>,
        manual: Pair<Mode, Long?>?, active: Mode?, modeEnds: LocalTime?, modeRemaining: Long?,
        locked: Boolean, lockUntil: Long?, free: Boolean, parentUntil: Long?,
    ): Snapshot {
        val cur = currentSection(day, t)
        val todayIds = todaySections.map { it.id }.toSet()
        val dayGrants = rules.grants.filter { !it.vault && it.window == null && (it.validOn == day || it.activatedOn == day) }
        fun sectionExtra(id: String) = dayGrants.filter { it.sectionId == id && it.activatedOn == null }.sumOf { it.minutes }
        val adjust = rules.commands
            .filter { !it.cancelled && it.type == CommandType.ADJUST && it.createdAt in dayStart until dayEnd }
            .sumOf { it.minutes ?: 0 }
        // Havuz: bölümü olmayan (ya da bugün olmayan bir bölüme verilmiş) süreler + cüzdandan bugün kullanılanlar + düzeltmeler
        val poolMin = dayGrants.filter { it.activatedOn == day || it.sectionId == null || it.sectionId !in todayIds }.sumOf { it.minutes } + adjust
        val allExtra = dayGrants.sumOf { it.minutes } + adjust + dayWindows(day).sumOf { it.minutes }

        // Bölüm zinciri: sırayla etkin süre, devreden, havuzdan taşan
        var carry = 0L
        var poolUsed = 0L
        var curLeft: Long? = null
        var curEff = 0L
        for (sec in todaySections.sortedWith(compareBy({ it.start }, { it.order }))) {
            val key = "${sec.id}@$day"
            val used = bucket(usage, "s:$key")
            if (sec.budgetMinutes == null) {
                if (cur?.key == key) curLeft = null
                continue
            }
            val eff = (sec.budgetMinutes + sectionExtra(sec.id)) * 60L + carry
            poolUsed += (used - eff).coerceAtLeast(0)
            val left = (eff - used).coerceAtLeast(0)
            if (cur?.key == key) { curLeft = left; curEff = eff }
            carry = if (sec.carryOver) left else 0
        }
        // Dünden taşan gece bölümü: kendi süresi (devretme yok)
        if (cur != null && cur.section.id !in todayIds && cur.section.budgetMinutes != null) {
            val eff = cur.section.budgetMinutes * 60L
            val used = bucket(usage, "s:${cur.key}")
            poolUsed += (used - eff).coerceAtLeast(0)
            curLeft = (eff - used).coerceAtLeast(0); curEff = eff
        }
        val poolLeft = (poolMin * 60L - poolUsed).coerceAtLeast(0)
        val capLeft = profile.maxTotalMinutes?.let { ((it + allExtra) * 60L - usage.countedSeconds).coerceAtLeast(0) }
        // Bölümde süreli hiçbir şey yoksa (ör. "Kapalı" / "Uyku") kalan süre 0 gösterilir
        val timedPossible = cur != null && (cur.section.defaultRule == SecRule.TIMED ||
            rules.sectionRules.any { it.sectionId == cur.section.id && it.rule == SecRule.TIMED })
        val sectionPart = if (!timedPossible) 0L else (curLeft ?: UNLIMITED_SECONDS)
        var remaining = if (!timedPossible) 0L else (sectionPart + poolLeft).coerceAtMost(UNLIMITED_SECONDS)
        if (capLeft != null) remaining = minOf(remaining, capLeft)

        val allowance = when {
            cur != null && curLeft != null -> ((curEff / 60) + poolMin).toInt()
            profile.maxTotalMinutes != null -> profile.maxTotalMinutes + allExtra
            else -> (UNLIMITED_SECONDS / 60).toInt()
        }
        return Snapshot(
            day = day, now = t, profile = profile, activeMode = active, modeIsManual = manual != null,
            modeEndsAt = modeEnds, locked = locked, lockUntil = lockUntil, free = free,
            allowanceMinutes = allowance, usedMinutes = (usage.countedSeconds / 60).toInt(), remainingSeconds = remaining,
            modeRemainingSeconds = modeRemaining, extraMinutesToday = allExtra, walletGrants = wallet,
            parentMode = parentUntil != null, parentModeUntil = parentUntil,
            sectionMode = true, section = cur, sectionLeftSeconds = curLeft, poolLeftSeconds = poolLeft, capLeftSeconds = capLeft,
            sectionClosed = cur != null && !timedPossible && cur.section.defaultRule == SecRule.BLOCKED &&
                rules.sectionRules.none { it.sectionId == cur.section.id && it.rule == SecRule.OPEN },
        )
    }

    private fun sectionVerdict(pkg: String, app: AppRule?, s: Snapshot, usage: DayUsage): AppVerdict {
        if (app == null || !app.approved) return AppVerdict(false, "Ebeveyn onayı bekliyor")
        if (app.group == Group.BLOCKED) return AppVerdict(false, "Bu uygulama kapalı")
        val cur = s.section ?: return AppVerdict(false, "Bu saatlerde kapalı")
        val sec = cur.section
        val appRule = rules.sectionRules.firstOrNull { it.sectionId == sec.id && it.pkg == pkg }
        val grp = rules.groupOf[pkg]
        val grpRule = if (appRule == null && grp != null) rules.sectionRules.firstOrNull { it.sectionId == sec.id && it.groupId == grp } else null
        val rule = appRule?.rule ?: grpRule?.rule ?: sec.defaultRule
        return when (rule) {
            SecRule.OPEN -> AppVerdict(true)
            SecRule.BLOCKED -> AppVerdict(false, "${sec.name}: bu uygulama şu an kapalı")
            SecRule.TIMED -> {
                if (rules.mandatoryOpen.isNotEmpty()) return AppVerdict(false, mandatoryReason())
                if (s.remainingSeconds <= 0) {
                    return AppVerdict(false, if (s.capLeftSeconds == 0L) "Bugünkü süren bitti" else "${sec.name} süren bitti")
                }
                val k = cur.key
                appRule?.limitMinutes?.let { if (bucket(usage, "sa:$k|$pkg") >= it * 60L) return AppVerdict(false, "Bu uygulamanın ${sec.name} sınırı doldu") }
                if (appRule == null && grp != null) {
                    val gName = rules.groupNames[grp] ?: "Grup"
                    grpRule?.limitMinutes?.let { if (bucket(usage, "sg:$k|$grp") >= it * 60L) return AppVerdict(false, "$gName için ${sec.name} süresi doldu") }
                    rules.groupLimits[s.profile.id]?.get(grp)?.let { if (bucket(usage, "g:$grp") >= it * 60L) return AppVerdict(false, "$gName için bugünkü süre doldu") }
                }
                app.dailyLimitMinutes?.let { if ((usage.perAppCounted[pkg] ?: 0) >= it * 60L) return AppVerdict(false, "Bu uygulamanın günlük sınırı doldu") }
                val b = mutableListOf("s:$k", "sa:$k|$pkg")
                if (grp != null) { b += "g:$grp"; b += "sg:$k|$grp" }
                AppVerdict(true, countsDaily = true, buckets = b)
            }
        }
    }

    private fun mandatoryReason() = "Önce görevini yap: ${rules.mandatoryOpen.first()}"

    private fun inWindows(ws: List<TimeWindow>, t: LocalTime) = ws.isEmpty() || ws.any { it.contains(t) }

    fun verdict(pkg: String, s: Snapshot, usage: DayUsage): AppVerdict {
        val app = rules.apps[pkg]
        val group = app?.group ?: Group.BLOCKED
        val approved = app?.approved == true

        if (s.parentMode) return AppVerdict(true)
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
                    if (countsDaily && rules.mandatoryOpen.isNotEmpty()) return AppVerdict(false, mandatoryReason())
                    if (countsDaily && s.remainingSeconds <= 0) return AppVerdict(false, "Günlük süren bitti")
                    return AppVerdict(true, countsDaily = countsDaily, countsMode = if (mode.budgetMinutes != null) mode.id else null)
                }
                if (mode.othersBlocked) return AppVerdict(false, "${mode.name} süresi bitti")
            } else if (mode.othersBlocked) {
                return AppVerdict(false, "Şu an ${mode.name}")
            }
        }

        if (s.sectionMode) return sectionVerdict(pkg, app, s, usage)
        if (!approved) return AppVerdict(false, "Ebeveyn onayı bekliyor")
        return when (group) {
            Group.ALWAYS_OPEN -> AppVerdict(true)
            Group.BLOCKED -> AppVerdict(false, "Bu uygulama kapalı")
            Group.UNLIMITED ->
                if (inWindows(s.profile.unlimitedWindows, s.now)) AppVerdict(true)
                else AppVerdict(false, "Bu saatlerde kapalı")
            Group.TIMED -> {
                if (!inWindows(s.profile.timedWindows, s.now)) return AppVerdict(false, "Bu saatlerde kapalı")
                if (rules.mandatoryOpen.isNotEmpty()) return AppVerdict(false, mandatoryReason())
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
        if (v.allowed && v.countsDaily && v.buckets.isNotEmpty()) {
            val m = u.buckets.toMutableMap()
            for (k in v.buckets) m[k] = (m[k] ?: 0) + seconds
            u = u.copy(buckets = m)
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
        val sec = s.section
        for (w in s.profile.warnMinutes.sortedDescending()) {
            if (s.sectionMode) {
                if (sec == null || s.remainingSeconds >= UNLIMITED_SECONDS) continue
                val key = "sec-${sec.key}-$w-${s.allowanceMinutes}"
                if (s.remainingSeconds > 0 && remMin <= w && key !in usage.warned) {
                    out += key to "${sec.section.name} süresinin bitmesine $w dakika kaldı"
                }
                continue
            }
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
