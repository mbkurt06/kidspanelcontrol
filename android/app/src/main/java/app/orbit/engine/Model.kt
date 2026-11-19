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
        // 23:59 bitişi "gün sonuna kadar" demek: son dakika da içeride (yoksa 23:59–00:00 arası bir dakika kilitleniyordu)
        if (end == LocalTime.of(23, 59)) t >= start
        else if (start < end) t >= start && t < end
        else if (start > end) t >= start || t < end
        else false
}

data class AppRule(
    val pkg: String,
    val label: String,
    val group: Group,
    val approved: Boolean,
    val dailyLimitMinutes: Int?,
    val usageRuleId: String? = null,
    /** Kiosk: kilitliyken de Orbit ekranından açılır, hiçbir zaman süreden düşmez */
    val kiosk: Boolean = false,
    /** Kiosk saatleri; boş = her zaman */
    val kioskWindows: List<TimeWindow> = emptyList(),
)

data class AppUsageRule(val id: String, val mode: String, val maxMinutes: Int?, val countsTowardDaily: Boolean, val window: TimeWindow? = null)

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
    val kioskEnabled: Boolean = false,
    val kioskScreens: Set<String> = emptySet(),
    val kioskCalls: String = "emergency",
    /** Hazır profil: open | timed | blocked | kiosk (gün profili bölüm türleri) */
    val builtin: String? = null,
    val kioskMessage: String? = null,
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
    /** Belirli bir bölüme verilen süre; null = gün boyu havuz */
    val sectionId: String? = null,
    /** Süre kasasında: çocuk kullanamaz, ebeveyn sonradan bir zamana aktarır */
    val vault: Boolean = false,
    /** O gün bu saatler arasında geçerli ekstra süre (bölüm kapalı olsa bile) */
    val window: TimeWindow? = null,
    /** Kullanılmayan kısmı bitişte kasaya aktarılır */
    val toVault: Boolean = false,
    val settled: Boolean = false,
    /** manual = ebeveyn verdi; task = görev ödülü; leftover / daily_surplus … */
    val source: String? = null,
    val createdAtMs: Long = 0L,
    /** Görev ödülüyse hangi görev koşusundan geldiği */
    val taskRunId: String? = null,
    /** Görevin telefon kilidi ayarı: k0 dokunmaz · k1 süresi bitene kadar · k2 gün boyu · k3 saate kadar; null = eski (aynı grup) */
    val unlock: String? = null,
    val unlockUntil: LocalTime? = null,
)

/** Bölüm kuralı: açık (süre saymaz) / süreli / kapalı */
enum class SecRule(val key: String) {
    OPEN("open"), TIMED("timed"), BLOCKED("blocked");

    companion object {
        fun of(k: String?): SecRule = entries.firstOrNull { it.key == k } ?: BLOCKED
    }
}

/** Gün tipinin bir bölümü (ör. Serbest 16:00–19:00, 60 dk). */
data class Section(
    val id: String,
    val profileId: String,
    val name: String,
    val start: LocalTime,
    val end: LocalTime,
    val budgetMinutes: Int?,
    val carryOver: Boolean,
    val defaultRule: SecRule,
    val order: Int = 0,
    /** Çocuğa gösterilen simge (emoji) ve mesaj */
    val icon: String? = null,
    val message: String? = null,
    /** Bu bölümde tam kilit (kiosk) */
    val kiosk: Boolean = false,
    /** Bu bölümde müzik çalabilir mi */
    val music: Boolean = true,
    /** Bölümün kullanım profili */
    val modeId: String? = null,
) {
    val crossesMidnight get() = start > end
}

/** Çalışan sayacın odak kısıtı: sadece bunlar açık kalır (kurallar zaten izin veriyorsa). */
data class Focus(val name: String, val groups: Set<String>, val packages: Set<String>)

/** Onaylanana kadar görevden gelen ek telefon/Orbit kısıtı. */
data class TaskRestriction(
    val title: String,
    val status: String,
    /** none | limit | kiosk | mode */
    val phoneMode: String,
    val screens: Set<String>,
    val runId: String = "",
    /** phoneMode = mode: kurallardaki durum */
    val modeId: String? = null,
    /** Görev saat aralığı: kısıtlama sadece bu aralıkta */
    val window: TimeWindow? = null,
    /** Son gün (tek seferlik); null = sadece bugün */
    val dueDate: LocalDate? = null,
    /** Kısıtlıyken izinli uygulamalar: paket → günlük dakika (null = sınırsız) */
    val allowed: Map<String, Int?> = emptyMap(),
    /** Görevin (koşunun) oluşturulma anı: ebeveyn bundan sonra süre verdiyse kısıtlama o süre boyunca kalkar */
    val createdAtMs: Long = 0L,
    /** Görev grubu: aynı gruptan kazanılan süre bu kısıtlamayı kaldırır (başka görevlerinkini değil) */
    val groupId: String? = null,
) {
    val active get() = status in setOf("open", "started", "submitted", "rejected")
    val rank get() = when (phoneMode) { "kiosk" -> 3; "limit" -> 2; "mode" -> 1; else -> 0 }
}

/** Bir bölümde bir grup (groupId) ya da tek uygulama (pkg) için kural. */
data class SectionRule(
    val sectionId: String,
    val groupId: String?,
    val pkg: String?,
    val rule: SecRule,
    val limitMinutes: Int?,
)

enum class CommandType(val key: String) {
    LOCK("lock"), UNLOCK("unlock"), START_MODE("start_mode"), END_MODE("end_mode"), ADJUST("adjust_minutes"), RESYNC("resync"),
    KIOSK_START("kiosk_start"), KIOSK_END("kiosk_end");

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
    /** Tam kilit: çocuğa mesaj ve açık Orbit ekranları (null = varsayılan) */
    val message: String? = null,
    val screens: Set<String>? = null,
    /** İleri tarihli kilit: bu andan (epoch ms) itibaren geçerli (ör. açık saati bugünlük kısaltma) */
    val fromAt: Long? = null,
)

/** Sunucudan alınan kuralların tamamı (telefonda saklanır, internet yokken de kullanılır). */
data class Rules(
    val timezone: String = "Europe/Berlin",
    /** Orbit günü bitişi (dakika, ör. 300 = 05:00): sayaçlar ve kalan sürenin kasaya geçişi bu saatte */
    val dayEndMin: Int = 300,
    val apps: Map<String, AppRule> = emptyMap(),
    val usageRules: Map<String, AppUsageRule> = emptyMap(),
    val profiles: Map<String, Profile> = emptyMap(),
    val modes: Map<String, Mode> = emptyMap(),
    val slots: List<ModeSlot> = emptyList(),
    /** haftanın günü (1–7) → profil */
    val assignments: Map<Int, String> = emptyMap(),
    val overrides: List<DayOverride> = emptyList(),
    val grants: List<Grant> = emptyList(),
    /** Uygulamaya özel süreler: gün → (paket → dk). Kullandıkça düşer, genel süreden ayrı. */
    val appGrants: Map<java.time.LocalDate, Map<String, Int>> = emptyMap(),
    /** Bugünlük genel süre kısıtı: gün → kısıt */
    val dayAppLimits: Map<java.time.LocalDate, DayAppLimit> = emptyMap(),
    val commands: List<Command> = emptyList(),
    /** Çocuğun oluşturduğu ajanda kayıtları */
    val agenda: List<app.orbit.data.AgendaItem> = emptyList(),
    /** Bugün yapılmamış zorunlu görevler (başlıkları). Bitmeden süreli uygulamalar açılmaz. */
    val mandatoryOpen: List<String> = emptyList(),
    /** Gün bölümleri (bir gün tipinde bölüm varsa yeni kural motoru kullanılır) */
    val sections: List<Section> = emptyList(),
    val sectionRules: List<SectionRule> = emptyList(),
    /** paket → grup id */
    val groupOf: Map<String, String> = emptyMap(),
    /** grup id → ad */
    val groupNames: Map<String, String> = emptyMap(),
    /** gün tipi id → (grup id → günlük dk sınırı) */
    val groupLimits: Map<String, Map<String, Int>> = emptyMap(),
    /** Çalışan sayacın odak profili */
    val focus: Focus? = null,
    /** Onay bekleyen görevlerin bağımsız kısıtları */
    val taskRestrictions: List<TaskRestriction> = emptyList(),
    /** Görev koşusu → grubu (kazanılan sürenin hangi grubun kilidini kaldıracağı) */
    val taskRunGroups: Map<String, String> = emptyMap(),
    /** Açık görevlerin izinli uygulamaları: görev sürerken her modda açık */
    val taskAllowedPackages: Set<String> = emptySet(),
    /** Çocuğun cüzdandan günde en fazla kullanabileceği dakika (null = sınır yok) */
    val walletDailyMax: Int? = null,
    /** Tam kilit varsayılanları */
    val kiosk: KioskSettings = KioskSettings(),
    /** Ek zaman kuralları (bu çocuğa ait olanlar) */
    val timeRules: List<TimeRule> = emptyList(),
    /** always | rules | never */
    val musicMode: String = "rules",
    /** null = çocuk seçer */
    val musicFolder: String? = null,
    /** Aile ebeveyn PIN'i (sha256("orbit:<aile>:<pin>")); bu çocukta kapalıysa null */
    val pinHash: String? = null,
    /** PIN ile kaç dakika açık kalır */
    val pinMinutes: Int = 15,
    val familyId: String = "",
    val profileNickname: String? = null,
    val profileAvatar: String? = null,
)

/** Genel süre sadece [apps] içinde (onlyApps), [caps] = paket → bugün en fazla dk */
data class DayAppLimit(
    val onlyApps: Boolean,
    val apps: Set<String>,
    val caps: Map<String, Int>,
    /** day = bugün verilen bütün süreler · now = sadece kısıt konduğu andaki [budget] dk (sonradan verilen süre serbest) */
    val scope: String = "day",
    val budget: Int? = null,
)

data class KioskSettings(
    val message: String? = null,
    val screens: Set<String> = setOf("tasks", "messages", "music", "timer", "alarms"),
    /** emergency | all */
    val calls: String = "emergency",
)

/** Bölümlerden bağımsız zaman kuralı: tam kilit / müzik kapalı / müzik açık */
data class TimeRule(
    val id: String,
    val name: String,
    /** kiosk | limit | free | music_off | music_on */
    val kind: String,
    val days: Set<Int>,
    val window: TimeWindow,
    val message: String? = null,
    val screens: Set<String>? = null,
    /** Geçerlilik aralığı (ör. tatil); null = sınırsız */
    val startDate: java.time.LocalDate? = null,
    val endDate: java.time.LocalDate? = null,
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
    /**
     * Bölüm sayaçları (saniye): "s:<bölüm>@<tarih>", "g:<grup>", "sg:<bölüm>@<tarih>|<grup>", "sa:<bölüm>@<tarih>|<paket>"
     */
    val buckets: Map<String, Long> = emptyMap(),
)
