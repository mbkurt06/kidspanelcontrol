package app.orbit.engine

import java.time.LocalDate
import java.time.LocalTime

/** Uygulama grubu (ebeveyn panelinde atanır). */
enum class Group(val key: String) {
    ALWAYS_OPEN("always_open"), UNLIMITED("unlimited"), TIMED("timed"), BLOCKED("blocked");

    companion object {
        fun of(k: String?): Group = entries.firstOrNull { it.key == k } ?: BLOCKED
    }
}

data class TimeWindow(val start: LocalTime, val end: LocalTime) {
    /** Bitiş başlangıçtan önceyse gece yarısını geçer (21:00–07:00). */
    fun contains(t: LocalTime): Boolean =
        if (start < end) t >= start && t < end
        else if (start > end) t >= start || t < end
        else false
}

data class AppRule(
    val pkg: String,
    val label: String,
    val group: Group,
    val approved: Boolean,
    val dailyLimitMinutes: Int?,
)

data class Profile(
    val id: String,
    val name: String,
    val dailyMinutes: Int,
    val maxTotalMinutes: Int?,
    val timedWindows: List<TimeWindow>,
    val unlimitedWindows: List<TimeWindow>,
    val warnMinutes: List<Int>,
)

data class Mode(
    val id: String,
    val name: String,
    val color: String,
    val allowedPackages: Set<String>,
    val allowedGroups: Set<Group>,
    val budgetMinutes: Int?,
    val countsTowardDaily: Boolean,
    val othersBlocked: Boolean,
    val extraTimeAllowed: Boolean,
    val warnMinutes: List<Int>,
    val priority: Int,
)

data class ModeSlot(
    val profileId: String,
    val modeId: String,
    /** ISO günleri: 1 = Pazartesi … 7 = Pazar */
    val days: Set<Int>,
    val start: LocalTime,
    val end: LocalTime,
)

data class DayOverride(val day: LocalDate, val profileId: String?, val dailyMinutes: Int?, val note: String?)

data class Grant(
    val id: String,
    val minutes: Int,
    val validOn: LocalDate?,
    val expiresOn: LocalDate?,
    val activatedOn: LocalDate?,
    val note: String?,
)

enum class CommandType(val key: String) {
    LOCK("lock"), UNLOCK("unlock"), START_MODE("start_mode"), END_MODE("end_mode"), ADJUST("adjust_minutes"), RESYNC("resync");

    companion object {
        fun of(k: String?): CommandType? = entries.firstOrNull { it.key == k }
    }
}

data class Command(
    val id: String,
    val type: CommandType,
    /** epoch ms */
    val createdAt: Long,
    val untilAt: Long?,
    val modeId: String?,
    val minutes: Int?,
    val free: Boolean,
    val cancelled: Boolean,
    /** Bakım: geliştirici seçenekleri/adb geçici olarak açılır (ebeveyn bilgisayardan bakım yapacaksa) */
    val maintenance: Boolean = false,
)

/** Sunucudan alınan kuralların tamamı (telefonda saklanır, internet yokken de kullanılır). */
data class Rules(
    val timezone: String = "Europe/Berlin",
    val apps: Map<String, AppRule> = emptyMap(),
    val profiles: Map<String, Profile> = emptyMap(),
    val modes: Map<String, Mode> = emptyMap(),
    val slots: List<ModeSlot> = emptyList(),
    /** haftanın günü (1–7) → profil */
    val assignments: Map<Int, String> = emptyMap(),
    val overrides: List<DayOverride> = emptyList(),
    val grants: List<Grant> = emptyList(),
    val commands: List<Command> = emptyList(),
    /** Bugün yapılmamış zorunlu görevler (başlıkları). Bitmeden süreli uygulamalar açılmaz. */
    val mandatoryOpen: List<String> = emptyList(),
)

/** Telefonda gün boyunca tutulan sayaçlar (saniye). Gece yarısı sıfırlanır. */
data class DayUsage(
    val day: LocalDate,
    /** Günlük süreden düşen toplam */
    val countedSeconds: Long = 0,
    /** Uygulama başına günlük süreden düşen (uygulama sınırı için) */
    val perAppCounted: Map<String, Long> = emptyMap(),
    /** Uygulama başına toplam ön plan süresi (rapor için) */
    val perAppTotal: Map<String, Long> = emptyMap(),
    /** Durum başına kullanılan süre */
    val perMode: Map<String, Long> = emptyMap(),
    /** Gönderilen uyarılar (tekrar gösterilmesin) */
    val warned: Set<String> = emptySet(),
)
