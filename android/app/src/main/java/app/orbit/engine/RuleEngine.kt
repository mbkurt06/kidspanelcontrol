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
    /** Programdaki "Sınırla" kuralının adı (sınırlıysa) */
    val limitName: String? = null,
    /** Programdaki "Serbest" kuralının adı */
    val freeName: String? = null,
    /** Açık bölümde geçerli saat aralıklı süreler: kullanım bu sayaçlara da yazılır */
    val windowBuckets: List<String> = emptyList(),
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
        // Bölümün kullanım profili (Serbest / Süreli / Tam kilit bölüm türüyle işler; ek süre aralığında uygulanmaz)
        if (windowSection(day, t) == null) regularSection(day, t)?.let { sn ->
            val m = sn.section.modeId?.let { rules.modes[it] } ?: return@let
            // Sade Serbest/Süreli (özel uygulama listesi, süre ya da kapatma yoksa) bölüm türüyle işler; tam kilit bölüm kilidinden gelir
            val plain = !m.othersBlocked && m.allowedPackages.isEmpty() && m.allowedGroups.isEmpty() && m.budgetMinutes == null
            if (!m.kioskEnabled && !plain) out += m to sn.section.end
        }
        return out
    }

    /** Tek aktif profil: elle uygulanan profil programlı profilin önüne geçer. */
    fun activeModeAt(day: LocalDate, t: LocalTime): Mode? {
        val nowMs = day.atTime(t).atZone(zone).toInstant().toEpochMilli()
        return manualMode(nowMs)?.first ?: scheduledModes(day, t).maxByOrNull { it.first.priority }?.first
    }

    fun extraMinutes(day: LocalDate, dayStartMs: Long, dayEndMs: Long): Int {
        val grants = rules.grants.filter { !it.vault && it.window == null && (it.validOn == day || it.activatedOn == day) }.sumOf { it.minutes }
        // Cüzdana yazılan ceza (borç) sadece cüzdan bakiyesinden düşer; günlük / verilen süreye dokunmaz
        val walletDebt = 0
        val adjust = rules.commands
            .filter { !it.cancelled && it.type == CommandType.ADJUST && it.createdAt in dayStartMs until dayEndMs }
            .sumOf { it.minutes ?: 0 }
        return grants + walletDebt + adjust
    }

    /** Önceki günün kullanılmayan günlük hakkı; sınırsız günlerde artan süre yoktur. */
    fun surplusMinutes(day: LocalDate, usage: DayUsage): Int {
        val sections = daySections(day)
        val base = if (sections.isEmpty()) {
            val profile = profileFor(day)
            val start = day.atStartOfDay(zone).toInstant().toEpochMilli()
            val end = day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
            val raw = profile.dailyMinutes + extraMinutes(day, start, end)
            profile.maxTotalMinutes?.let { minOf(raw, it) } ?: raw
        } else {
            // Kilitli bölümün süresi yoktur; sınırsız sayılmaz (artan süre hep 0 çıkıyordu)
            if (sections.any { it.defaultRule != SecRule.BLOCKED && it.budgetMinutes == null }) return 0
            // Güne eklenen süreler: o güne verilenler + o gün cüzdandan açılanlar
            sections.filter { it.defaultRule != SecRule.BLOCKED }.sumOf { it.budgetMinutes ?: 0 } + rules.grants.filter {
                !it.vault && it.window == null && (it.validOn == day || it.activatedOn == day)
            }.sumOf { it.minutes }
        }
        return ((base * 60L - usage.countedSeconds).coerceAtLeast(0) / 60L).toInt()
    }

    fun snapshot(nowZ: ZonedDateTime, usage: DayUsage): Snapshot {
        val now = nowZ.withZoneSameInstant(zone)
        val day = now.toLocalDate()
        val t = now.toLocalTime()
        val nowMs = now.toInstant().toEpochMilli()
        val dayStart = day.atStartOfDay(zone).toInstant().toEpochMilli()
        val dayEnd = day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()

        val profile = profileFor(day)
        val (lockedCmd, free0, lockUntil0) = lockState(nowMs)
        // Ebeveynin şu an için verdiği saat aralıklı süre "Sınırla"yı (elle ya da programdan) o süre boyunca açar
        val windowNow = activeWindows(day, t).isNotEmpty()
        // Elle kilit her zaman kilitler; sadece kilitten SONRA elle verilen süre / geçici açma o aralıkta kaldırır
        val lockAt = rules.commands.filter { !it.cancelled && it.type == CommandType.LOCK }.maxOfOrNull { it.createdAt } ?: 0L
        val locked0 = lockedCmd && activeWindows(day, t).none { it.source == "manual" && it.createdAtMs > lockAt }
        // Görevin kısıtlaması: sadece ebeveynin elle verdiği süre sürerken kalkar
        // (görev ödülü ya da cüzdandan açılan süre kısıtlamayı kaldırmaz)
        val taskR = taskRestrictionNow(day, t)
        raNow = if (taskR != null) restrictedAllowedNow(day, t) else emptyMap()
        raDay = day
        // Kilit programı: "Sınırla" (sadece her zaman açık uygulamalar) ve "Serbest"
        val limit = if (locked0) null else (if (windowNow) null else Extras.limitNow(rules, this, day, t))
            ?: taskR?.takeIf { it.phoneMode == "limit" }?.let { r ->
                "Önce görev: ${r.title}" to (r.window?.end?.let { day.atTime(it).atZone(zone).toInstant().toEpochMilli() } ?: dayEnd)
            }
        val freeRule = if (locked0 || limit != null || free0) null else Extras.freeNow(rules, this, day, t)
        val locked = locked0 || limit != null
        val lockUntil = if (locked0) lockUntil0 else limit?.second
        val free = free0 || freeRule != null
        val manual = manualMode(nowMs)
        val sched = scheduledModes(day, t).maxByOrNull { it.first.priority }
        val taskMode = taskR?.takeIf { it.phoneMode == "mode" }?.modeId?.let { rules.modes[it] }
        val active = taskMode ?: manual?.first ?: sched?.first
        val modeEnds = if (manual != null) manual.second?.let { java.time.Instant.ofEpochMilli(it).atZone(zone).toLocalTime() } else sched?.second

        val parentUntil = parentModeUntil(nowMs)
        val extra = extraMinutes(day, dayStart, dayEnd)
        var allowance = (profile.dailyMinutes + extra).coerceAtLeast(0)
        profile.maxTotalMinutes?.let { allowance = minOf(allowance, it) }
        val used = usage.countedSeconds
        val remaining = (allowance * 60L - used).coerceAtLeast(0)
        val modeRemaining = active?.budgetMinutes?.let { (it * 60L - (usage.perMode[active.id] ?: 0)).coerceAtLeast(0) }

        val wallet = rules.grants.filter {
            !it.vault && it.minutes > 0 && it.validOn == null && it.activatedOn == null && (it.expiresOn == null || !it.expiresOn.isBefore(day))
        }

        val todaySections = rules.sections.filter { it.profileId == profile.id }
        if (todaySections.isNotEmpty()) {
            return sectionSnapshot(
                now, day, t, profile, todaySections, usage, dayStart, dayEnd, wallet,
                manual, active, modeEnds, modeRemaining, locked, lockUntil, free, parentUntil,
            ).copy(limitName = limit?.first, freeName = freeRule?.first)
        }

        return Snapshot(
            day = day, now = t, profile = profile, activeMode = active, modeIsManual = manual != null,
            modeEndsAt = modeEnds, locked = locked, lockUntil = lockUntil, free = free,
            allowanceMinutes = allowance, usedMinutes = (used / 60).toInt(), remainingSeconds = remaining,
            modeRemainingSeconds = modeRemaining, extraMinutesToday = extra, walletGrants = wallet,
            parentMode = parentUntil != null, parentModeUntil = parentUntil,
            limitName = limit?.first, freeName = freeRule?.first,
        )
    }

    // --- Bölümler ---

    /** Saat aralıklı ekstra süre, sanal bir bölüm olarak (bölüm kapalıyken o aralıkta telefon açılır). */
    private fun windowAsSection(g: Grant, day: LocalDate): SectionNow {
        val w = g.window!!
        val sec = Section(
            "grant:${g.id}", profileFor(day).id, g.note?.takeIf { it.isNotBlank() } ?: "Ekstra süre",
            w.start, w.end, g.minutes, false, SecRule.TIMED, 0, "🎁", "Ebeveynin verdiği ekstra süre",
        )
        return SectionNow(sec, day, w.end)
    }

    /** Bölümde süreli uygulama kullanılabilir mi */
    fun timedPossible(sec: Section): Boolean =
        sec.defaultRule == SecRule.TIMED || rules.sectionRules.any { it.sectionId == sec.id && it.rule == SecRule.TIMED }

    /** Şu an geçerli saat aralıklı süreler */
    fun activeWindows(day: LocalDate, t: LocalTime): List<Grant> = dayWindows(day).filter { it.window!!.contains(t) && it.id !in spentWindows && it.minutes > 0 }

    /** Süresi tamamen kullanılmış saat aralıkları (kısıtlamayı artık kaldırmaz) */
    var spentWindows: Set<String> = emptySet()

    /** Saat aralıklı sürede kullanılan saniye */
    /** Aralıktan harcanan: açık saatte w: (her saniye tek bir aralığa yazılır), kapalı saatte s:grant: */
    fun windowUsedSeconds(usage: DayUsage, g: Grant, day: LocalDate) = bucket(usage, "s:grant:${g.id}@$day") + bucket(usage, "w:${g.id}")

    fun refreshSpent(usage: DayUsage, day: LocalDate) {
        spentWindows = dayWindows(day).filter { windowUsedSeconds(usage, it, day) >= it.minutes * 60L }.map { it.id }.toSet()
    }

    /** Şu an geçerli zorunlu görev kısıtlamaları (görev saat aralığında, onaylanmamış) */
    fun taskRestrictionsNow(day: LocalDate, t: LocalTime): List<TaskRestriction> = rules.taskRestrictions.filter {
        it.active && it.phoneMode != "none" && (it.window?.contains(t) ?: true) && (it.dueDate == null || !day.isAfter(it.dueDate))
    }

    /** Şu an kalkmamış bütün görev kısıtlamaları ("Açmak için" listesi) */
    fun liveTaskRestrictions(day: LocalDate, t: LocalTime): List<TaskRestriction> {
        val wins = activeWindows(day, t).filter { it.source == "manual" || it.source == "task" }
        fun lifts(g: Grant, r: TaskRestriction) = g.createdAtMs > r.createdAtMs && (
            g.source == "manual" || (r.groupId != null && g.taskRunId != null && rules.taskRunGroups[g.taskRunId] == r.groupId))
        return taskRestrictionsNow(day, t).filter { r -> wins.none { lifts(it, r) } }
    }

    /** Hazır süre: şu an geçerli, kullanılmamış ekstra / görev süreleri (dakika) */
    fun readyMinutes(usage: DayUsage, day: LocalDate, t: LocalTime): Int =
        activeWindows(day, t).sumOf { g -> ((g.minutes * 60L - windowUsedSeconds(usage, g, day)).coerceAtLeast(0) / 60).toInt() }

    /** En sıkı kısıtlama: Kilitle > Sınırla > durum */
    fun taskRestrictionNow(day: LocalDate, t: LocalTime): TaskRestriction? {
        // Görevden sonra ebeveynin elle verdiği ya da görevden kazanılan süre sürerken kısıtlama kalkar;
        // süre bitince (kullanıldı / saat doldu) sıradaki zorunlu görevin kısıtlaması geri gelir
        val wins = activeWindows(day, t).filter { it.source == "manual" || it.source == "task" }
        fun lifts(g: Grant, r: TaskRestriction) = g.createdAtMs > r.createdAtMs && (
            g.source == "manual" ||
                // Görevden kazanılan süre sadece aynı grubun kilidini kaldırır (tek görevin ya da başka grubun kilidi sürer)
                (r.groupId != null && g.taskRunId != null && rules.taskRunGroups[g.taskRunId] == r.groupId))
        return taskRestrictionsNow(day, t).filter { r -> wins.none { lifts(it, r) } }.maxByOrNull { it.rank }
    }

    /** Kısıtlıyken izinli uygulamalar: paket → günlük dakika sınırı */
    fun restrictedAllowedNow(day: LocalDate, t: LocalTime): Map<String, Int?> {
        val m = HashMap<String, Int?>()
        for (r in taskRestrictionsNow(day, t)) for ((p, mins) in r.allowed) {
            m[p] = if (!m.containsKey(p)) mins else { val o = m[p]; if (o == null || mins == null) null else maxOf(o, mins) }
        }
        return m
    }

    /** Kısıtlıyken izinli uygulamanın kalan süresi var mı */
    fun restrictedLeft(pkg: String, usage: DayUsage): Boolean {
        if (!raNow.containsKey(pkg)) return false
        val mins = raNow[pkg] ?: return true
        return bucket(usage, "ra:$pkg@$raDay") < mins * 60L
    }

    /** Son anlık durumda geçerli kısıtlıyken izinli uygulamalar */
    var raNow: Map<String, Int?> = emptyMap()
        private set
    private var raDay: LocalDate? = null

    /** Görev oturumu (Göreve başla / ekran kaydı): görev uygulamaları her durumda açık, süre saymaz */
    var sessionPackages: Set<String> = emptySet()

    /**
     * Saat aralığı sanal bölümü: sadece o an normal bölüm kapalıysa (süreli kullanım yoksa).
     * Açık bölümde aralık süresi bölümün kalanına eklenir (bkz. sectionSnapshot).
     */
    fun windowSection(day: LocalDate, t: LocalTime): SectionNow? {
        val reg = regularSection(day, t)
        if (reg != null && timedPossible(reg.section)) return null
        // Birden fazla süre verildiyse en son biteni taşıyıcı olur; kalanlar toplanır (bkz. sectionSnapshot)
        return activeWindows(day, t).maxByOrNull { it.window!!.end }?.let { windowAsSection(it, day) }
    }

    /** Bugünün bölümleri (saat sırasıyla) — çocuğun "Günüm" ekranı için. */
    fun daySections(day: LocalDate): List<Section> =
        rules.sections.filter { it.profileId == profileFor(day).id }.sortedWith(compareBy({ it.start }, { it.order }))

    /** Bugün için saat aralıklı ekstra süreler. */
    /** Aralığın bitişine kalan saniye */
    private fun secsToEnd(g: Grant, t: LocalTime): Long {
        val w = g.window ?: return UNLIMITED_SECONDS
        val end = if (w.end == LocalTime.of(23, 59) || w.end <= w.start) 86_400L else w.end.toSecondOfDay().toLong()
        return (end - t.toSecondOfDay()).coerceAtLeast(0)
    }

    /** Panelden "Geçici aç": kilidi aralık boyunca kaldırır, süre olarak eklenmez */
    fun isTempOpen(g: Grant) = g.source == "manual" && g.note?.startsWith("Geçici açma") == true

    fun dayWindows(day: LocalDate): List<Grant> = rules.grants.filter { !it.vault && it.validOn == day && it.window != null }

    fun currentSection(day: LocalDate, t: LocalTime): SectionNow? = windowSection(day, t) ?: regularSection(day, t)

    /** Şu anki bölüm: bugünün bölümleri önce; yoksa dünden taşan (gece yarısını geçen) bölüm. */
    fun regularSection(day: LocalDate, t: LocalTime): SectionNow? {
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
        // Cüzdana yazılan ceza (borç) sadece cüzdan bakiyesinden düşer; günlük / verilen süreye dokunmaz
        val walletDebt = 0
        // Havuz: bölümü olmayan (ya da bugün olmayan bir bölüme verilmiş) süreler + cüzdandan bugün kullanılanlar + düzeltmeler
        val poolMin = dayGrants.filter { it.activatedOn == day || it.sectionId == null || it.sectionId !in todayIds }.sumOf { it.minutes } + walletDebt + adjust
        // Saat aralıklı süreler: açık bölümdeyken o anki kalana eklenir; aralık bitince kullanılmayan kısım düşer
        val virtualWin = cur?.section?.id?.startsWith("grant:") == true
        val overlay = if (virtualWin || cur == null || !timedPossible(cur.section)) emptyList() else activeWindows(day, t).filter { !isTempOpen(it) }
        var winCredit = 0L
        for (g in dayWindows(day).filter { !isTempOpen(it) }) {
            val sv = bucket(usage, "s:grant:${g.id}@$day")
            val w = bucket(usage, "w:${g.id}")
            val left = (g.minutes * 60L - sv - w).coerceAtLeast(0)
            // Havuza katkı: bu aralıktan harcanan (w) + açıksa kalan kısmı (en fazla bitişine kadar)
            winCredit += minOf(w, (g.minutes * 60L - sv).coerceAtLeast(0)) + if (g in overlay) minOf(left, secsToEnd(g, t)) else 0L
        }
        val allExtra = dayGrants.sumOf { it.minutes } + walletDebt + adjust + dayWindows(day).filter { !isTempOpen(it) }.sumOf { it.minutes }
        // Geçici açma: süre eklemez; çocuğun kendi süresi bitse bile aralık sonuna kadar açık tutar
        val tempLeft = activeWindows(day, t).filter { isTempOpen(it) }.maxOfOrNull { w ->
            val end = if (w.window!!.end == LocalTime.MIDNIGHT || w.window.end <= w.window.start) 86_400L else w.window.end.toSecondOfDay().toLong()
            (end - t.toSecondOfDay()).coerceAtLeast(0)
        } ?: 0L

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
        if (virtualWin) {
            // Kapalı saatte verilen süreler üst üste eklenir: o an saatleri geçerli bütün aralıkların toplamından
            // açık saatte (w:) ve kapalı saatte (s:grant:, taşıyıcı aralığa yazılır) harcananlar düşülür.
            val inTime = dayWindows(day).filter { !isTempOpen(it) && it.window!!.contains(t) && it.minutes > 0 }
            curEff = inTime.sumOf { it.minutes } * 60L
            val used = inTime.sumOf { bucket(usage, "w:${it.id}") + bucket(usage, "s:grant:${it.id}@$day") }
            // Saat gibi akan / aralıklı süre bitiş saatini geçemez
            val maxEnd = inTime.maxOfOrNull { secsToEnd(it, t) } ?: 0L
            curLeft = (curEff - used).coerceAtLeast(0).coerceAtMost(maxEnd)
        } else if (cur != null && (cur.section.id !in todayIds || cur.startDay != day) && cur.section.budgetMinutes != null) {
            // Dünden taşan gece bölümü: kendi süresi (devretme yok)
            val eff = cur.section.budgetMinutes * 60L
            val used = bucket(usage, "s:${cur.key}")
            poolUsed += (used - eff).coerceAtLeast(0)
            curLeft = (eff - used).coerceAtLeast(0); curEff = eff
        }
        val poolRaw = poolMin * 60L + winCredit - poolUsed
        val poolLeft = if (virtualWin) 0L else poolRaw.coerceAtLeast(0)
        // Ebeveynin düşürdüğü süre (eksi düzeltme) havuzu aşarsa o anki bölümden / saat aralıklı süreden de düşer
        val cut = if (virtualWin) (-(adjust + walletDebt) * 60L).coerceAtLeast(0) else (-poolRaw).coerceAtLeast(0).coerceAtMost((-(adjust + walletDebt) * 60L).coerceAtLeast(0))
        if (cut > 0 && curLeft != null) curLeft = (curLeft!! - cut).coerceAtLeast(0)
        val capLeft = profile.maxTotalMinutes?.let { ((it + allExtra) * 60L - usage.countedSeconds).coerceAtLeast(0) }
        // Bölümde süreli hiçbir şey yoksa (ör. "Kapalı" / "Uyku") kalan süre 0 gösterilir
        val timedPossible = cur != null && timedPossible(cur.section)
        // "Açık" bölüm (süre sayılmaz, her şey açık): kalan sınırsız gösterilir, "Kapalı" değil
        val openSection = cur != null && !timedPossible && cur.section.defaultRule == SecRule.OPEN
        val sectionPart = if (!timedPossible) 0L else (curLeft ?: UNLIMITED_SECONDS)
        var remaining = if (openSection) UNLIMITED_SECONDS else if (!timedPossible) 0L else (sectionPart + poolLeft).coerceAtMost(UNLIMITED_SECONDS)
        if (capLeft != null) remaining = minOf(remaining, capLeft)
        if (tempLeft > 0 && remaining < tempLeft) remaining = tempLeft

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
            // Açık saatte kullanım (önce bitecek olan harcansın diye) TEK bir aralığa yazılır: en erken biten, yeri olan.
            // Eskiden geçerli bütün aralıklara aynı anda yazılıyordu; birden çok süre varken hepsi erkenden "bitmiş" görünüyordu.
            windowBuckets = if (overlay.isEmpty()) emptyList() else listOfNotNull(
                overlay.filter { g -> g.minutes * 60L - bucket(usage, "s:grant:${g.id}@$day") - bucket(usage, "w:${g.id}") > 0 }
                    .minByOrNull { secsToEnd(it, t) }?.let { "w:${it.id}" }
            ),
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
                if (hasMandatoryBlock()) return AppVerdict(false, mandatoryReason())
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
                b += s.windowBuckets
                if (grp != null) { b += "g:$grp"; b += "sg:$k|$grp" }
                AppVerdict(true, countsDaily = true, buckets = b)
            }
        }
    }

    private fun hasMandatoryBlock() = rules.mandatoryOpen.isNotEmpty()
    private fun mandatoryReason() = "Önce görevini yap: ${rules.mandatoryOpen.first()}"

    private fun inWindows(ws: List<TimeWindow>, t: LocalTime) = ws.isEmpty() || ws.any { it.contains(t) }

    fun verdict(pkg: String, s: Snapshot, usage: DayUsage): AppVerdict {
        // Görevin izinli uygulaması: görev açıkken her durumda açık, süreden düşmez
        if (s.parentMode) return AppVerdict(true)
        if (pkg in sessionPackages) return AppVerdict(true)
        // Zorunlu görev kısıtlaması sürerken izin verilen uygulamalar (isteğe bağlı günlük dakika)
        if (raNow.containsKey(pkg) && restrictedLeft(pkg, usage)) return AppVerdict(true, buckets = listOf("ra:$pkg@$raDay"))
        val v = baseVerdict(pkg, s, usage)
        if (s.parentMode || !v.allowed) return v
        // Sayaç odak modu: kuralların açtıklarından sadece odak profilindekiler açık kalır
        val f = rules.focus ?: return v
        if (pkg in f.packages || rules.groupOf[pkg]?.let { it in f.groups } == true) return v
        return AppVerdict(false, "Odak: ${f.name} — bu uygulama şu an kapalı")
    }

    private fun baseVerdict(pkg: String, s: Snapshot, usage: DayUsage): AppVerdict {
        val app = rules.apps[pkg]
        val group = app?.group ?: Group.BLOCKED
        val approved = app?.approved == true

        if (s.parentMode) return AppVerdict(true)
        if (approved && group == Group.ALWAYS_OPEN) return AppVerdict(true)
        if (s.free) {
            return if (approved && group != Group.BLOCKED) AppVerdict(true) else AppVerdict(false, if (!approved) "Ebeveyn onayı bekliyor" else "Bu uygulama kapalı")
        }
        if (s.locked) return AppVerdict(false, s.limitName?.let { "$it: şu an sadece temel uygulamalar açık" } ?: "Telefon sınırlandı: sadece temel uygulamalar açık")

        val mode = s.activeMode
        if (mode != null) {
            val inMode = pkg in mode.allowedPackages || (approved && group in mode.allowedGroups && group != Group.BLOCKED)
            if (inMode) {
                val budgetLeft = s.modeRemainingSeconds?.let { it > 0 } ?: true
                if (budgetLeft) {
                    val countsDaily = mode.countsTowardDaily && group != Group.UNLIMITED
                    if (countsDaily && hasMandatoryBlock()) return AppVerdict(false, mandatoryReason())
                    if (countsDaily && s.remainingSeconds <= 0) return AppVerdict(false, "Günlük süren bitti")
                    return AppVerdict(true, countsDaily = countsDaily, countsMode = if (mode.budgetMinutes != null) mode.id else null)
                }
                if (mode.othersBlocked) return AppVerdict(false, "${mode.name} süresi bitti")
            } else if (mode.othersBlocked) {
                return AppVerdict(false, "Şu an ${mode.name}")
            }
        }

        customAppRule(app, pkg, s, usage)?.let { return it }

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
                if (hasMandatoryBlock()) return AppVerdict(false, mandatoryReason())
                if (s.remainingSeconds <= 0) return AppVerdict(false, "Günlük süren bitti")
                val limit = app?.dailyLimitMinutes
                if (limit != null && (usage.perAppCounted[pkg] ?: 0) >= limit * 60L) return AppVerdict(false, "Bu uygulamanın günlük sınırı doldu")
                AppVerdict(true, countsDaily = true)
            }
        }
    }

    private fun customAppRule(app: AppRule?, pkg: String, s: Snapshot, usage: DayUsage): AppVerdict? {
        val rule = app?.usageRuleId?.let { rules.usageRules[it] } ?: return null
        if (app.approved != true) return AppVerdict(false, "Ebeveyn onayı bekliyor")
        if (rule.window != null && !rule.window.contains(s.now)) return AppVerdict(false, "Bu saatlerde kapalı")
        return when (rule.mode) {
            "open" -> AppVerdict(true)
            "blocked" -> AppVerdict(false, "Bu uygulama kapalı")
            else -> {
                val spent = if (rule.countsTowardDaily) usage.perAppCounted[pkg] ?: 0L else usage.perAppTotal[pkg] ?: 0L
                if (rule.maxMinutes != null && spent >= rule.maxMinutes * 60L) return AppVerdict(false, "Bu uygulamanın süresi doldu")
                if (rule.countsTowardDaily && s.remainingSeconds <= 0) return AppVerdict(false, "Günlük süren bitti")
                AppVerdict(true, countsDaily = rule.countsTowardDaily)
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
        val raB = v.buckets.filter { it.startsWith("ra:") }
        if (v.allowed && raB.isNotEmpty()) {
            val m = u.buckets.toMutableMap()
            for (k in raB) m[k] = (m[k] ?: 0) + seconds
            u = u.copy(buckets = m)
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
