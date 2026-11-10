package app.orbit.data

import app.orbit.engine.AppRule
import app.orbit.engine.AppUsageRule
import app.orbit.engine.Command
import app.orbit.engine.CommandType
import app.orbit.engine.DayOverride
import app.orbit.engine.DayUsage
import app.orbit.engine.Grant
import app.orbit.engine.Group
import app.orbit.engine.Mode
import app.orbit.engine.ModeSlot
import app.orbit.engine.Profile
import app.orbit.engine.Rules
import app.orbit.engine.TimeWindow
import app.orbit.engine.SecRule
import app.orbit.engine.Section
import app.orbit.engine.SectionRule
import app.orbit.engine.TaskRestriction
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.OffsetDateTime

/** Supabase (PostgREST) cevaplarını kural modeline çevirir. Telefonda da aynı biçimde saklanır. */
object Parse {

    private fun JSONObject.str(k: String): String? = if (isNull(k)) null else optString(k)
    private fun JSONObject.intOrNull(k: String): Int? = if (isNull(k) || !has(k)) null else optInt(k)

    fun time(s: String): LocalTime = LocalTime.parse(if (s.length == 5) s else s.substring(0, 8))
    fun date(s: String?): LocalDate? = s?.takeIf { it.isNotBlank() }?.let { LocalDate.parse(it.substring(0, 10)) }
    fun ts(s: String?): Long? = s?.takeIf { it.isNotBlank() }?.let { v ->
        runCatching { OffsetDateTime.parse(v).toInstant().toEpochMilli() }
            .getOrElse { Instant.parse(v).toEpochMilli() }
    }

    private fun strings(a: JSONArray?): List<String> = (0 until (a?.length() ?: 0)).map { a!!.optString(it) }
    private fun ints(a: JSONArray?): List<Int> = (0 until (a?.length() ?: 0)).map { a!!.optInt(it) }

    private fun taskRestrictions(tasks: JSONArray?, focusProfiles: JSONArray?): List<TaskRestriction> {
        val screens = (0 until (focusProfiles?.length() ?: 0)).associate { i ->
            val p = focusProfiles!!.getJSONObject(i)
            p.getString("id") to strings(p.optJSONArray("allowed_screens")).toSet()
        }
        return (0 until (tasks?.length() ?: 0)).mapNotNull { i ->
            val t = tasks!!.getJSONObject(i)
            // "restriction": yeni anahtar (eski sürümler "phone_restriction"ı hiç uygulamıyordu)
            val mode = t.optString("restriction", "none")
            val profile = t.str("orbit_focus_profile_id")
            if (mode == "none" && profile == null) return@mapNotNull null
            val win = runCatching { TimeWindow(time(t.getString("window_start")), time(t.getString("window_end"))) }.getOrNull()
            val allowed = t.optJSONArray("restricted_allowed")?.let { a ->
                (0 until a.length()).mapNotNull { j ->
                    val o = a.optJSONObject(j) ?: return@mapNotNull null
                    val p = o.str("package") ?: return@mapNotNull null
                    p to o.intOrNull("minutes")
                }.toMap()
            } ?: emptyMap()
            TaskRestriction(
                t.optString("title", "Görev"), t.optString("status"), mode, profile?.let { screens[it].orEmpty() }.orEmpty(),
                runId = t.optString("run_id"), modeId = t.str("restriction_mode_id"), window = win,
                dueDate = if (t.optString("recurrence") == "once") date(t.str("due_date")) else date(t.str("day")),
                allowed = allowed,
            )
        }
    }

    /** Kısıtlıyken izinli uygulamaların hepsi (tam kilitte ekran sabitleme listesi için) */
    private fun taskAllowed(tasks: JSONArray?): Set<String> = (0 until (tasks?.length() ?: 0)).flatMap { i ->
        val t = tasks!!.getJSONObject(i)
        if (t.optString("status") in setOf("open", "started", "submitted", "rejected") && t.optString("restriction", "none") != "none")
            t.optJSONArray("restricted_allowed")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it)?.str("package") } } ?: emptyList()
        else emptyList()
    }.filter { it.isNotBlank() }.toSet()

    private fun windows(a: JSONArray?): List<TimeWindow> = (0 until (a?.length() ?: 0)).mapNotNull {
        val o = a!!.optJSONObject(it) ?: return@mapNotNull null
        runCatching { TimeWindow(time(o.getString("start")), time(o.getString("end"))) }.getOrNull()
    }

    fun apps(a: JSONArray): Map<String, AppRule> = (0 until a.length()).associate {
        val o = a.getJSONObject(it)
        val p = o.getString("package")
        p to AppRule(p, o.optString("label", p), Group.of(o.str("app_group")), o.optBoolean("approved"), o.intOrNull("daily_limit_minutes"), o.str("usage_rule_id"))
    }

    fun usageRules(a: JSONArray): Map<String, AppUsageRule> = (0 until a.length()).associate { val o = a.getJSONObject(it); val w = runCatching { if (o.isNull("start_time") || !o.has("start_time")) null else TimeWindow(time(o.getString("start_time")), time(o.getString("end_time"))) }.getOrNull(); o.getString("id") to AppUsageRule(o.getString("id"), o.optString("mode", "timed"), o.intOrNull("max_minutes"), o.optBoolean("counts_toward_daily", true), w) }

    fun profiles(a: JSONArray): Map<String, Profile> = (0 until a.length()).associate {
        val o = a.getJSONObject(it)
        val id = o.getString("id")
        id to Profile(
            id, o.optString("name"), o.optInt("daily_minutes", 60), o.intOrNull("max_total_minutes"),
            windows(o.optJSONArray("timed_windows")), windows(o.optJSONArray("unlimited_windows")),
            ints(o.optJSONArray("warn_minutes")),
        )
    }

    fun modes(a: JSONArray): Map<String, Mode> = (0 until a.length()).associate {
        val o = a.getJSONObject(it)
        val id = o.getString("id")
        id to Mode(
            id, o.optString("name"), o.optString("color", "#7C5CFF"),
            strings(o.optJSONArray("allowed_packages")).toSet(),
            strings(o.optJSONArray("allowed_groups")).map { g -> Group.of(g) }.toSet(),
            o.intOrNull("budget_minutes"), o.optBoolean("counts_toward_daily"), o.optBoolean("others_blocked", true),
            o.optBoolean("extra_time_allowed"), ints(o.optJSONArray("warn_minutes")), o.optInt("priority", 50),
            o.optBoolean("kiosk_enabled", false), strings(o.optJSONArray("kiosk_screens")).toSet(), o.optString("kiosk_calls", "emergency"),
            o.str("builtin"), o.str("kiosk_message")?.takeIf { it.isNotBlank() },
        )
    }

    fun slots(a: JSONArray): List<ModeSlot> = (0 until a.length()).map {
        val o = a.getJSONObject(it)
        ModeSlot(o.getString("profile_id"), o.getString("mode_id"), ints(o.optJSONArray("days")).toSet(), time(o.getString("start_time")), time(o.getString("end_time")))
    }

    fun assignments(a: JSONArray): Map<Int, String> = (0 until a.length()).associate {
        val o = a.getJSONObject(it)
        o.getInt("weekday") to o.getString("profile_id")
    }

    fun overrides(a: JSONArray): List<DayOverride> = (0 until a.length()).map {
        val o = a.getJSONObject(it)
        DayOverride(date(o.getString("day"))!!, o.str("profile_id"), o.intOrNull("daily_minutes"), o.str("note"))
    }

    fun grants(a: JSONArray): List<Grant> = (0 until a.length()).map {
        val o = a.getJSONObject(it)
        Grant(o.getString("id"), o.optInt("minutes"), date(o.str("valid_on")), date(o.str("expires_on")), date(o.str("activated_on")), o.str("note"), o.str("section_id"),
            o.optBoolean("vault"),
            runCatching { if (o.isNull("window_start") || !o.has("window_start")) null else TimeWindow(time(o.getString("window_start")), time(o.getString("window_end"))) }.getOrNull(),
            toVault = o.optBoolean("to_vault"), settled = !o.isNull("settled_at") && o.has("settled_at"))
    }

    fun commands(a: JSONArray): List<Command> = (0 until a.length()).mapNotNull {
        val o = a.getJSONObject(it)
        val type = CommandType.of(o.str("type")) ?: return@mapNotNull null
        val p = o.optJSONObject("payload") ?: JSONObject()
        Command(
            o.getString("id"), type, ts(o.str("created_at")) ?: 0L, ts(o.str("until_at")),
            p.str("mode_id"), if (p.has("minutes")) p.optInt("minutes") else null, p.optBoolean("free"),
            !o.isNull("cancelled_at"),
            p.optBoolean("maintenance"),
            p.str("message")?.takeIf { it.isNotBlank() },
            p.optJSONArray("screens")?.let { strings(it).toSet() },
        )
    }

    fun sections(a: JSONArray): List<Section> = (0 until a.length()).mapNotNull {
        val o = a.getJSONObject(it)
        runCatching {
            Section(
                o.getString("id"), o.getString("profile_id"), o.optString("name"),
                time(o.getString("start_time")), time(o.getString("end_time")),
                o.intOrNull("budget_minutes"), o.optBoolean("carry_over"), SecRule.of(o.str("default_rule")), o.optInt("sort_order"),
                o.str("icon")?.takeIf { it.isNotBlank() }, o.str("message")?.takeIf { it.isNotBlank() },
                o.optBoolean("kiosk", false), if (o.has("music")) o.optBoolean("music", true) else true,
                o.str("mode_id"),
            )
        }.getOrNull()
    }

    fun timeRules(a: JSONArray, childId: String): List<app.orbit.engine.TimeRule> = (0 until a.length()).mapNotNull {
        val o = a.getJSONObject(it)
        runCatching {
            if (!o.optBoolean("active", true)) return@runCatching null
            val kids = strings(o.optJSONArray("child_ids"))
            if (kids.isNotEmpty() && childId.isNotBlank() && childId !in kids) return@runCatching null
            app.orbit.engine.TimeRule(
                o.getString("id"), o.optString("name"), o.getString("kind"), ints(o.optJSONArray("days")).toSet(),
                TimeWindow(time(o.getString("start_time")), time(o.getString("end_time"))),
                o.str("message")?.takeIf { it.isNotBlank() },
                if (o.isNull("screens") || !o.has("screens")) null else strings(o.optJSONArray("screens")).toSet(),
                date(o.str("start_date")), date(o.str("end_date")),
            )
        }.getOrNull()
    }

    fun sectionRules(a: JSONArray): List<SectionRule> = (0 until a.length()).map {
        val o = a.getJSONObject(it)
        SectionRule(o.getString("section_id"), o.str("group_id"), o.str("package"), SecRule.of(o.str("rule")), o.intOrNull("limit_minutes"))
    }

    fun groupLimits(a: JSONArray): Map<String, Map<String, Int>> = (0 until a.length()).map { a.getJSONObject(it) }
        .groupBy { it.getString("profile_id") }
        .mapValues { (_, l) -> l.associate { it.getString("group_id") to it.optInt("daily_minutes") } }

    /** Sunucudan gelen ham parçaları tek bir JSON'da saklar. */
    fun rulesFromBundle(b: JSONObject): Rules = Rules(
        timezone = b.optString("timezone", "Europe/Berlin"),
        apps = apps(b.optJSONArray("apps") ?: JSONArray()),
        usageRules = usageRules(b.optJSONArray("usage_rules") ?: JSONArray()),
        profiles = profiles(b.optJSONArray("profiles") ?: JSONArray()),
        modes = modes(b.optJSONArray("modes") ?: JSONArray()),
        slots = slots(b.optJSONArray("slots") ?: JSONArray()),
        assignments = assignments(b.optJSONArray("assignments") ?: JSONArray()),
        overrides = overrides(b.optJSONArray("overrides") ?: JSONArray()),
        grants = grants(b.optJSONArray("grants") ?: JSONArray()),
        commands = commands(b.optJSONArray("commands") ?: JSONArray()),
        agenda = Agenda.parse(b.optJSONArray("agenda")),
        mandatoryOpen = Tasks.parse(b.optJSONArray("tasks")).filter { it.blocking }.map { it.title },
        sections = sections(b.optJSONArray("sections") ?: JSONArray()),
        sectionRules = sectionRules(b.optJSONArray("section_rules") ?: JSONArray()),
        groupOf = (b.optJSONArray("group_members") ?: JSONArray()).let { m -> (0 until m.length()).associate { m.getJSONObject(it).let { o -> o.getString("package") to o.getString("group_id") } } },
        groupNames = (b.optJSONArray("groups") ?: JSONArray()).let { m -> (0 until m.length()).associate { m.getJSONObject(it).let { o -> o.getString("id") to o.optString("name") } } },
        groupLimits = groupLimits(b.optJSONArray("group_limits") ?: JSONArray()),
        walletDailyMax = if (b.isNull("wallet_daily_max") || !b.has("wallet_daily_max")) null else b.optInt("wallet_daily_max"),
        kiosk = b.optJSONObject("child")?.optJSONObject("kiosk_settings")?.let { k ->
            app.orbit.engine.KioskSettings(
                k.str("message")?.takeIf { it.isNotBlank() },
                k.optJSONArray("screens")?.let { strings(it).toSet() } ?: app.orbit.engine.KioskSettings().screens,
                k.optString("calls", "emergency"),
            )
        } ?: app.orbit.engine.KioskSettings(),
        timeRules = timeRules(b.optJSONArray("time_rules") ?: JSONArray(), b.optString("child_id")),
        musicMode = b.optJSONObject("child")?.optString("music_mode", "rules") ?: "rules",
        musicFolder = b.optJSONObject("child")?.str("music_folder")?.takeIf { it.isNotBlank() },
        pinHash = b.optJSONObject("child")?.takeIf { it.optBoolean("parent_pin_enabled") }
            ?.let { b.optJSONObject("family")?.str("parent_pin_hash")?.takeIf { h -> h.isNotBlank() } },
        pinMinutes = b.optJSONObject("family")?.optInt("pin_unlock_minutes", 15)?.takeIf { it > 0 } ?: 15,
        familyId = b.optJSONObject("family")?.optString("id") ?: "",
        profileNickname = b.optJSONObject("child")?.str("profile_nickname"),
        profileAvatar = b.optJSONObject("child")?.str("profile_avatar"),
        focus = Timers.activeFocus(b)?.let { app.orbit.engine.Focus(it.name, it.groups, it.packages) },
        taskRestrictions = taskRestrictions(b.optJSONArray("tasks"), b.optJSONArray("focus_profiles")),
        taskAllowedPackages = taskAllowed(b.optJSONArray("tasks")),
    )

    // --- Gün sayaçları ---

    private fun longMap(o: JSONObject?): Map<String, Long> = o?.keys()?.asSequence()?.associateWith { o.optLong(it) } ?: emptyMap()
    private fun JSONObject.putMap(k: String, m: Map<String, Long>) = put(k, JSONObject().apply { m.forEach { (a, b) -> put(a, b) } })

    fun usageToJson(u: DayUsage): String = JSONObject().apply {
        put("day", u.day.toString())
        put("counted", u.countedSeconds)
        putMap("perAppCounted", u.perAppCounted)
        putMap("perAppTotal", u.perAppTotal)
        putMap("perMode", u.perMode)
        put("warned", JSONArray(u.warned.toList()))
        putMap("buckets", u.buckets)
    }.toString()

    fun usageFromJson(s: String): DayUsage {
        val o = JSONObject(s)
        return DayUsage(
            LocalDate.parse(o.getString("day")), o.optLong("counted"),
            longMap(o.optJSONObject("perAppCounted")), longMap(o.optJSONObject("perAppTotal")), longMap(o.optJSONObject("perMode")),
            strings(o.optJSONArray("warned")).toSet(),
            longMap(o.optJSONObject("buckets")),
        )
    }
}
