package app.orbit.engine

import java.time.LocalDate
import java.time.LocalTime
import java.time.ZonedDateTime

/** O an geçerli tam kilit (kiosk). */
data class KioskNow(
    /** manual | rule | section */
    val source: String,
    val name: String,
    val message: String?,
    val screens: Set<String>,
    /** Bitiş (epoch ms); null = süresiz */
    val untilMs: Long?,
)

/** Tam kilit ve müzik kuralları — saf, test edilebilir. */
object Extras {

    private fun ms(engine: RuleEngine, d: LocalDate, t: LocalTime) = d.atTime(t).atZone(engine.zone()).toInstant().toEpochMilli()

    /** Kural şu an geçerliyse bu geçerliliğin başlangıç ve bitişi (ms). */
    fun ruleSpan(r: TimeRule, engine: RuleEngine, day: LocalDate, t: LocalTime): Pair<Long, Long>? {
        val w = r.window
        fun on(d: LocalDate) = d.dayOfWeek.value in r.days &&
            (r.startDate == null || !d.isBefore(r.startDate)) && (r.endDate == null || !d.isAfter(r.endDate))
        if (w.start < w.end) {
            if (on(day) && t >= w.start && t < w.end) return ms(engine, day, w.start) to ms(engine, day, w.end)
            return null
        }
        if (on(day) && t >= w.start) return ms(engine, day, w.start) to ms(engine, day.plusDays(1), w.end)
        val y = day.minusDays(1)
        if (on(y) && t < w.end) return ms(engine, y, w.start) to ms(engine, day, w.end)
        return null
    }

    fun kiosk(rules: Rules, engine: RuleEngine, nowZ: ZonedDateTime): KioskNow? {
        val now = nowZ.withZoneSameInstant(engine.zone())
        val day = now.toLocalDate()
        val t = now.toLocalTime()
        val nowMs = now.toInstant().toEpochMilli()
        val def = rules.kiosk
        val last = rules.commands
            .filter { !it.cancelled && (it.type == CommandType.KIOSK_START || it.type == CommandType.KIOSK_END) }
            .maxByOrNull { it.createdAt }
        // Ebeveynin kilitten SONRA verdiği süre / "Geçici aç" o aralık boyunca elle kilidi kaldırır; aralık bitince kilit kaldığı yerden sürer
        val openedAfter = last?.type == CommandType.KIOSK_START &&
            engine.activeWindows(day, t).any { engine.isTempOpen(it) && it.createdAtMs > last.createdAt }
        if (last?.type == CommandType.KIOSK_START && (last.untilAt == null || last.untilAt > nowMs) && (last.fromAt == null || nowMs >= last.fromAt) && !openedAfter) {
            return KioskNow("manual", "Tam kilit", last.message ?: def.message, last.screens ?: def.screens, last.untilAt)
        }
        // Görevin Tam kilidi: görev ödülü / eski süreler kaldırmaz; sadece görevden sonra ebeveynin verdiği süre (taskRestrictionNow)
        engine.taskRestrictionNow(day, t)?.takeIf { it.phoneMode == "kiosk" || (it.phoneMode == "mode" && rules.modes[it.modeId]?.kioskEnabled == true) }?.let { task ->
            val end = task.window?.end?.let { day.atTime(it).atZone(engine.zone()).toInstant().toEpochMilli() }
            return KioskNow("task", "Önce görev: ${task.title}", def.message, task.screens.ifEmpty { def.screens } + "tasks", end)
        }
        // Ebeveynin verdiği (ya da görevden kazanılan) saat aralıklı süre sürerken programlı kilit kalkar
        if (engine.activeWindows(day, t).any { engine.isTempOpen(it) }) return null
        engine.activeModeAt(day, t)?.takeIf { it.kioskEnabled }?.let { mode ->
            return KioskNow("profile", mode.name, mode.kioskMessage ?: def.message, mode.kioskScreens.ifEmpty { def.screens }, null)
        }
        // Ebeveyn "kilidi kaldır" dediyse o an süren programlı kilit biter (sonraki seferde yine başlar)
        val endedAt = if (last?.type == CommandType.KIOSK_END) last.createdAt else 0L
        for (r in rules.timeRules) {
            if (r.kind != "kiosk") continue
            val (start, end) = ruleSpan(r, engine, day, t) ?: continue
            if (start > endedAt) return KioskNow("rule", r.name, r.message ?: def.message, r.screens ?: def.screens, end)
        }
        val sec = engine.regularSection(day, t)
        if (sec != null && sec.section.kiosk) {
            val s = sec.section
            val start = ms(engine, sec.startDay, s.start)
            val end = ms(engine, if (s.crossesMidnight) sec.startDay.plusDays(1) else sec.startDay, s.end)
            // Tam kilit bölümü: ekranlar ve mesaj "Tam kilit" kullanım profilinden
            val m = s.modeId?.let { rules.modes[it] }
            if (start > endedAt) return KioskNow("section", s.name, s.message ?: m?.kioskMessage ?: def.message, m?.kioskScreens?.ifEmpty { null } ?: def.screens, end)
        }
        return null
    }

    /** Programdaki "Sınırla": (ad, bitiş ms). Ebeveyn sonradan "kilidi kaldır" (unlock) dediyse o sefer biter. */
    fun limitNow(rules: Rules, engine: RuleEngine, day: LocalDate, t: LocalTime): Pair<String, Long>? {
        val unlockedAt = rules.commands.filter { !it.cancelled && it.type == CommandType.UNLOCK }.maxOfOrNull { it.createdAt } ?: 0L
        for (r in rules.timeRules) {
            if (r.kind != "limit") continue
            val (start, end) = ruleSpan(r, engine, day, t) ?: continue
            if (start > unlockedAt) return r.name to end
        }
        return null
    }

    /** Programdaki "Serbest": o saatte süre ve kurallar işlemez. */
    fun freeNow(rules: Rules, engine: RuleEngine, day: LocalDate, t: LocalTime): Pair<String, Long>? {
        for (r in rules.timeRules) {
            if (r.kind != "free") continue
            val (_, end) = ruleSpan(r, engine, day, t) ?: continue
            return r.name to end
        }
        return null
    }

    /** Müzik şu an çalamıyorsa nedeni; çalabiliyorsa null. */
    fun musicBlocked(rules: Rules, engine: RuleEngine, nowZ: ZonedDateTime): String? {
        when (rules.musicMode) {
            "never" -> return "Müzik kapalı"
            "always" -> return null
        }
        val now = nowZ.withZoneSameInstant(engine.zone())
        val day = now.toLocalDate()
        val t = now.toLocalTime()
        val active = rules.timeRules.filter { it.kind.startsWith("music") && ruleSpan(it, engine, day, t) != null }
        if (active.any { it.kind == "music_on" }) return null
        active.firstOrNull { it.kind == "music_off" }?.let { return "Müzik şu an kapalı (${it.name})" }
        val sec = engine.regularSection(day, t)
        if (sec != null && !sec.section.music) return "${sec.section.name}: müzik kapalı"
        return null
    }
}
