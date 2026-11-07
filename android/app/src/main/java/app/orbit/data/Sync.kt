package app.orbit.data

import android.content.Context
import android.os.Build
import android.util.Log
import app.orbit.BuildConfig
import app.orbit.device.Policy
import app.orbit.engine.DayUsage
import app.orbit.engine.Snapshot
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/** Sunucu ile alışveriş: kuralları çek, durumu ve kullanımı gönder, komutları onayla. */
object Sync {
    private const val TAG = "OrbitSync"

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    /** Kuralları çeker ve telefona kaydeder. Başarılıysa true. */
    suspend fun pullRules(): Boolean {
        val c = Store.creds ?: return false
        val child = enc(c.childId)
        return try {
            // Aile/çocuk bilgisi bağımsız; ikisini aynı anda al.
            val (fam, kid) = coroutineScope {
                val famJob = async(Dispatchers.IO) {
                    runCatching { Api.get("families?select=id,timezone,parent_pin_hash,pin_unlock_minutes&limit=1") }
                        .getOrElse { Api.get("families?select=timezone&limit=1") }
                }
                val kidJob = async(Dispatchers.IO) {
                    runCatching { Api.get("children?select=name,wallet_daily_max,kiosk_settings,parent_pin_hash,parent_pin_enabled,music_mode,music_folder,profile_nickname,profile_avatar,wifi_settings&id=eq.$child") }
                        .getOrElse { Api.get("children?select=name&id=eq.$child") }
                }
                famJob.await() to kidJob.await()
            }
            val tz = fam.optJSONObject(0)?.optString("timezone") ?: "Europe/Berlin"
            val today = java.time.LocalDate.now(java.time.ZoneId.of(tz)).toString()

            // Bu istekler birbirinden bağımsız. Seri çekim telefonda her değişikliği 5–7 sn geciktiriyordu.
            val bundle = coroutineScope {
                val timeRules = async(Dispatchers.IO) { runCatching { Api.get("time_rules?select=*") }.getOrElse { JSONArray() } }
                val apps = async(Dispatchers.IO) { Api.get("child_apps?child_id=eq.$child&select=package,label,app_group,approved,daily_limit_minutes,usage_rule_id") }
                val usageRules = async(Dispatchers.IO) { runCatching { Api.get("app_usage_rules?select=id,mode,max_minutes,counts_toward_daily,start_time,end_time") }.getOrElse { JSONArray() } }
                val profiles = async(Dispatchers.IO) { Api.get("rule_profiles?select=*") }
                val modes = async(Dispatchers.IO) { Api.get("modes?select=*") }
                val slots = async(Dispatchers.IO) { Api.get("mode_slots?select=*") }
                val assignments = async(Dispatchers.IO) { Api.get("profile_assignments?child_id=eq.$child&select=weekday,profile_id") }
                val overrides = async(Dispatchers.IO) { Api.get("day_overrides?child_id=eq.$child&select=*") }
                val grants = async(Dispatchers.IO) { Api.get("time_grants?child_id=eq.$child&select=*&order=created_at.desc&limit=100") }
                val commands = async(Dispatchers.IO) { Api.get("commands?child_id=eq.$child&select=*&order=created_at.desc&limit=60") }
                val sections = async(Dispatchers.IO) { runCatching { Api.get("profile_sections?select=*") }.getOrElse { JSONArray() } }
                val sectionRules = async(Dispatchers.IO) { runCatching { Api.get("section_rules?select=*") }.getOrElse { JSONArray() } }
                val groups = async(Dispatchers.IO) { runCatching { Api.get("app_groups?select=id,name") }.getOrElse { JSONArray() } }
                val groupMembers = async(Dispatchers.IO) { runCatching { Api.get("app_group_members?select=package,group_id") }.getOrElse { JSONArray() } }
                val groupLimits = async(Dispatchers.IO) { runCatching { Api.get("profile_group_limits?select=*") }.getOrElse { JSONArray() } }
                val focusProfiles = async(Dispatchers.IO) { runCatching { Api.get("focus_profiles?select=*&order=sort_order") }.getOrElse { JSONArray() } }
                val activities = async(Dispatchers.IO) { runCatching { Api.get("activities?select=*&order=sort_order") }.getOrElse { JSONArray() } }
                val timerSessions = async(Dispatchers.IO) { runCatching { Api.get("timer_sessions?child_id=eq.$child&status=in.(running,paused)&select=*") }.getOrElse { JSONArray() } }
                val alarms = async(Dispatchers.IO) { runCatching { Api.get("alarms?child_id=eq.$child&select=*&order=at_time") }.getOrElse { JSONArray() } }
                val tasks = async(Dispatchers.IO) { runCatching { JSONArray(Api.rpc("device_tasks", JSONObject().put("p_day", today))) }.getOrElse { JSONArray() } }
                val agenda = async(Dispatchers.IO) { runCatching { Api.get("agenda_items?child_id=eq.$child&select=*&order=due_date.asc,due_time.asc,entered_at.desc") }.getOrElse { JSONArray() } }

                JSONObject()
                    .put("timezone", tz)
                    .put("wallet_daily_max", kid.optJSONObject(0)?.takeIf { it.has("wallet_daily_max") && !it.isNull("wallet_daily_max") }?.optInt("wallet_daily_max") ?: JSONObject.NULL)
                    .put("child", kid.optJSONObject(0) ?: JSONObject())
                    .put("family", fam.optJSONObject(0) ?: JSONObject())
                    .put("child_id", c.childId)
                    .put("time_rules", timeRules.await())
                    .put("apps", apps.await())
                    .put("usage_rules", usageRules.await())
                    .put("profiles", profiles.await())
                    .put("modes", modes.await())
                    .put("slots", slots.await())
                    .put("assignments", assignments.await())
                    .put("overrides", overrides.await())
                    .put("grants", grants.await())
                    .put("commands", commands.await())
                    .put("sections", sections.await())
                    .put("section_rules", sectionRules.await())
                    .put("groups", groups.await())
                    .put("group_members", groupMembers.await())
                    .put("group_limits", groupLimits.await())
                    .put("focus_profiles", focusProfiles.await())
                    .put("activities", activities.await())
                    .put("timer_sessions", timerSessions.await())
                    .put("alarms", alarms.await())
                    .put("tasks", tasks.await())
                    .put("agenda", agenda.await())
            }
            Store.rulesJson = bundle.toString()
            kid.optJSONObject(0)?.optString("name")?.let { Store.childName = it }
            Wifi.applySettings(kid.optJSONObject(0)?.optJSONObject("wifi_settings"))
            // Kasadaki Wi-Fi ağları (panelden eklenenler dahil) telefona tanıtılır; 5 dk'da bir
            runCatching { Wifi.syncVault() }.onFailure { Log.w(TAG, "wifi kasa", it) }
            // Panelde alarm sesi seçilebilsin diye telefonun ses listesi (değişince)
            runCatching { Sounds.report(Store.appCtx) }
            Store.lastSync = System.currentTimeMillis()
            runCatching { TaskAlerts.onTasks(Tasks.current()) }
            runCatching { Alarms.reschedule() }
            runCatching { Messages.refresh() }
            ackCommands(bundle.getJSONArray("commands"))
            true
        } catch (e: Throwable) {
            Log.w(TAG, "kurallar alınamadı", e)
            false
        }
    }

    private fun ackCommands(a: JSONArray) {
        val fresh = (0 until a.length()).map { a.getJSONObject(it) }.filter { it.isNull("acked_at") }
        val ids = fresh.map { it.getString("id") }
        if (ids.isEmpty()) return
        // Ebeveyn panelden "güncellemeyi şimdi kontrol et" dediyse bir sonraki turda hemen kontrol edilir
        if (fresh.any { it.optJSONObject("payload")?.optBoolean("update") == true }) { Store.updateCheckOnly = false; Store.lastUpdateCheck = 0 }
        if (fresh.any { it.optJSONObject("payload")?.optBoolean("check_update") == true }) { Store.updateCheckOnly = true; Store.lastUpdateCheck = 0 }
        // Panel kasa anahtarı istiyor (yeni ebeveyn cihazı)
        if (fresh.any { it.optJSONObject("payload")?.optBoolean("vault") == true }) Vault.shareSoon()
        // Telefonu bul (panelden çaldır / ses / durdur)
        for (c in fresh.sortedBy { it.optString("created_at") }) {
            val pl = c.optJSONObject("payload") ?: continue
            if (pl.has("find")) runCatching { app.orbit.ui.FindPhone.handle(Store.appCtx, c.getString("id"), pl, c.optString("created_at")) }
        }
        // Panelde Wi-Fi ağı eklendi/silindi: hemen eşitle
        if (fresh.any { it.optJSONObject("payload")?.optBoolean("wifi") == true }) Thread { runCatching { Wifi.syncVault(force = true) } }.start()
        runCatching {
            Api.patch("commands?id=in.(${ids.joinToString(",")})", JSONObject().put("acked_at", Instant.now().toString()))
        }
    }

    /** Yüklü uygulamaları bildirir. İlk seferde temel uygulamalar onaylı ve "her zaman açık" gelir. */
    fun reportApps(ctx: Context, initial: Boolean) {
        val essentials = Policy.essentials(ctx)
        val arr = JSONArray()
        for (a in Policy.launchables(ctx) + Policy.hiddenFeedApps(ctx)) {
            val o = JSONObject().put("package", a.pkg).put("label", a.label).put("system", a.system)
            a.category?.let { o.put("category", it) }
            if (a.pkg in essentials) o.put("default_group", "always_open").put("preapproved", true)
            if (initial) o.put("initial", true)
            arr.put(o)
        }
        runCatching { Api.rpc("device_report_apps", JSONObject().put("p_apps", arr)) }
            .onSuccess { Store.prefs().edit().putBoolean("appsReported", true).apply() }
            .onFailure { Log.w(TAG, "uygulamalar bildirilemedi", it) }
    }

    fun pushStatus(ctx: Context, s: Snapshot, usage: DayUsage, foreground: String?, lockReason: String?, battery: Int?) {
        val c = Store.creds ?: return
        runCatching {
            Api.post(
                "device_status?on_conflict=child_id",
                JSONObject()
                    .put("child_id", c.childId).put("device_id", c.deviceId).put("day", s.day.toString())
                    .put("used_minutes", s.usedMinutes).put("allowance_minutes", s.allowanceMinutes)
                    .put("remaining_minutes", (s.remainingSeconds / 60).toInt())
                    .put("current_mode_id", s.activeMode?.id ?: JSONObject.NULL)
                    .put("current_mode_name", s.activeMode?.name ?: s.section?.section?.name ?: JSONObject.NULL)
                    .put("locked", s.locked).put("lock_reason", lockReason ?: JSONObject.NULL)
                    .put("foreground_package", foreground ?: JSONObject.NULL)
                    .put("battery", battery ?: JSONObject.NULL)
                    .put("updated_at", Instant.now().toString()),
                upsert = true,
            )
            pushUsage(usage)
            Api.patch(
                "devices?id=eq.${c.deviceId}",
                JSONObject().put("last_seen_at", Instant.now().toString()).put("app_version", BuildConfig.VERSION_NAME)
                    .put("is_device_owner", Policy.isOwner(ctx)).put("os_version", Build.VERSION.RELEASE)
                    .put("model", "${Build.MANUFACTURER} ${Build.MODEL}"),
            )
        }.onFailure { Log.w(TAG, "durum gönderilemedi", it) }
    }

    fun pushUpdateStatus(status: String, target: Int? = null, error: String? = null) {
        val c = Store.creds ?: return
        runCatching {
            Api.patch(
                "devices?id=eq.${c.deviceId}",
                JSONObject()
                    .put("update_status", status)
                    .put("update_target", target ?: JSONObject.NULL)
                    .put("update_checked_at", Instant.now().toString())
                    .put("last_update_at", Store.lastUpdateAt.takeIf { it > 0 }?.let { Instant.ofEpochMilli(it).toString() } ?: JSONObject.NULL)
                    .put("update_error", error ?: JSONObject.NULL),
            )
        }.onFailure { Log.w(TAG, "güncelleme durumu bildirilemedi", it) }
    }

    fun pushUsage(u: DayUsage) {
        val c = Store.creds ?: return
        if (u.perAppTotal.isEmpty()) return
        val arr = JSONArray()
        for ((pkg, sec) in u.perAppTotal) {
            arr.put(
                JSONObject().put("child_id", c.childId).put("day", u.day.toString()).put("package", pkg)
                    .put("minutes", (sec / 60).toInt()).put("counted_minutes", ((u.perAppCounted[pkg] ?: 0) / 60).toInt())
                    .put("updated_at", Instant.now().toString())
            )
        }
        Api.post("usage_daily?on_conflict=child_id,day,package", arr, upsert = true)
    }

    /** Gün sonunda kullanılmayan hakkı idempotent olarak süre kasasına aktarır. */
    fun storeDailySurplus(day: java.time.LocalDate, minutes: Int): Boolean {
        if (minutes <= 0) return true
        return runCatching {
            Api.rpc("device_store_daily_surplus", JSONObject().put("p_day", day.toString()).put("p_minutes", minutes))
            true
        }.onFailure { Log.w(TAG, "günlük artan süre kaydedilemedi", it) }.getOrDefault(false)
    }

    /** Kanıt dosyasını yükler ve görev kaydına ekler. */
    fun uploadProof(runId: String, stage: String, media: String, bytes: ByteArray, contentType: String) {
        val c = Store.creds ?: throw Api.ApiError(401, "Eşleşmemiş")
        val ext = if (media == "video") "mp4" else "jpg"
        val name = "${stage}-${java.time.LocalTime.now().toString().take(8).replace(':', '-')}-${System.currentTimeMillis() % 100000}.$ext"
        // Önce OneDrive (bağlıysa), değilse Orbit deposu
        val od = runCatching { Cloud.uploadBytes(bytes, name, contentType) }.onFailure { Cloud.log("OneDrive yüklemesi", it) }.getOrNull()
        val path = if (od != null) "${c.familyId}/$runId/od:$od" else "${c.familyId}/$runId/${stage}-${System.currentTimeMillis()}.$ext"
        if (od == null) Api.upload("orbit-proofs", path, bytes, contentType)
        Api.rpc("device_add_proof", JSONObject().put("p_run", runId).put("p_stage", stage).put("p_media", media).put("p_path", path))
    }

    fun submitTask(runId: String) {
        Api.rpc("device_submit_run", JSONObject().put("p_run", runId))
    }

    /** Cüzdandan bugün kullan. Başarılıysa null, değilse çocuğa gösterilecek hata. */
    fun useWallet(minutes: Int): String? = runCatching {
        Api.rpc("device_use_wallet", JSONObject().put("p_minutes", minutes)); null
    }.getOrElse { e ->
        val m = e.message ?: ""
        when {
            "wallet_limit" in m -> {
                val left = Regex("wallet_limit:(\\d+)").find(m)?.groupValues?.get(1)?.toIntOrNull() ?: 0
                if (left > 0) "Bugün cüzdandan en fazla $left dk daha kullanabilirsin" else "Bugünkü cüzdan sınırın doldu"
            }
            "wallet_empty" in m -> "Cüzdanında süre yok"
            "wallet_closed" in m -> {
                val h = Regex("wallet_closed:([0-9:]+-[0-9:]+)").find(m)?.groupValues?.get(1)?.replace("-", "–")
                "Cüzdan açık saatlerde${h?.let { " ($it)" } ?: ""} kullanılır"
            }
            else -> "İnternet gerekli"
        }
    }

    fun event(type: String, payload: JSONObject = JSONObject()): Boolean {
        val c = Store.creds ?: return false
        return runCatching {
            Api.post("events", JSONObject().put("family_id", c.familyId).put("child_id", c.childId).put("type", type).put("payload", payload))
            true
        }.onFailure { Log.w(TAG, "olay gönderilemedi", it) }.getOrDefault(false)
    }
}
