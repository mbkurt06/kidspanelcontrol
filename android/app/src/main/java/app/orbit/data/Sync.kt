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

/** Sunucu ile alışveriş: kuralları çek, durumu ve kullanımı gönder, komutları onayla. */
object Sync {
    private const val TAG = "OrbitSync"

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    /** Kuralları çeker ve telefona kaydeder. Başarılıysa true. */
    fun pullRules(): Boolean {
        val c = Store.creds ?: return false
        val child = enc(c.childId)
        return runCatching {
            val fam = runCatching { Api.get("families?select=id,timezone,parent_pin_hash,pin_unlock_minutes&limit=1") }
                .getOrElse { Api.get("families?select=timezone&limit=1") }
            val tz = fam.optJSONObject(0)?.optString("timezone") ?: "Europe/Berlin"
            val today = java.time.LocalDate.now(java.time.ZoneId.of(tz)).toString()
            val kid = runCatching { Api.get("children?select=name,wallet_daily_max,kiosk_settings,parent_pin_hash,parent_pin_enabled,music_mode,music_folder&id=eq.$child") }
                .getOrElse { Api.get("children?select=name&id=eq.$child") }
            val bundle = JSONObject()
                .put("timezone", fam.optJSONObject(0)?.optString("timezone") ?: "Europe/Berlin")
                .put("wallet_daily_max", kid.optJSONObject(0)?.takeIf { it.has("wallet_daily_max") && !it.isNull("wallet_daily_max") }?.optInt("wallet_daily_max") ?: JSONObject.NULL)
                .put("child", kid.optJSONObject(0) ?: JSONObject())
                .put("family", fam.optJSONObject(0) ?: JSONObject())
                .put("child_id", c.childId)
                .put("time_rules", runCatching { Api.get("time_rules?select=*") }.getOrElse { JSONArray() })
                .put("apps", Api.get("child_apps?child_id=eq.$child&select=package,label,app_group,approved,daily_limit_minutes,usage_rule_id"))
                .put("usage_rules", runCatching { Api.get("app_usage_rules?select=id,mode,max_minutes,counts_toward_daily,start_time,end_time") }.getOrElse { JSONArray() })
                .put("profiles", Api.get("rule_profiles?select=*"))
                .put("modes", Api.get("modes?select=*"))
                .put("slots", Api.get("mode_slots?select=*"))
                .put("assignments", Api.get("profile_assignments?child_id=eq.$child&select=weekday,profile_id"))
                .put("overrides", Api.get("day_overrides?child_id=eq.$child&select=*"))
                .put("grants", Api.get("time_grants?child_id=eq.$child&select=*&order=created_at.desc&limit=100"))
                .put("commands", Api.get("commands?child_id=eq.$child&select=*&order=created_at.desc&limit=60"))
                .put("sections", runCatching { Api.get("profile_sections?select=*") }.getOrElse { JSONArray() })
                .put("section_rules", runCatching { Api.get("section_rules?select=*") }.getOrElse { JSONArray() })
                .put("groups", runCatching { Api.get("app_groups?select=id,name") }.getOrElse { JSONArray() })
                .put("group_members", runCatching { Api.get("app_group_members?select=package,group_id") }.getOrElse { JSONArray() })
                .put("group_limits", runCatching { Api.get("profile_group_limits?select=*") }.getOrElse { JSONArray() })
                .put("focus_profiles", runCatching { Api.get("focus_profiles?select=*&order=sort_order") }.getOrElse { JSONArray() })
                .put("activities", runCatching { Api.get("activities?select=*&order=sort_order") }.getOrElse { JSONArray() })
                .put("timer_sessions", runCatching { Api.get("timer_sessions?child_id=eq.$child&status=in.(running,paused)&select=*") }.getOrElse { JSONArray() })
                .put("alarms", runCatching { Api.get("alarms?child_id=eq.$child&select=*&order=at_time") }.getOrElse { JSONArray() })
                .put("tasks", runCatching { JSONArray(Api.rpc("device_tasks", JSONObject().put("p_day", today))) }.getOrElse { JSONArray() })
            Store.rulesJson = bundle.toString()
            kid.optJSONObject(0)?.optString("name")?.let { Store.childName = it }
            Store.lastSync = System.currentTimeMillis()
            runCatching { TaskAlerts.onTasks(Tasks.current()) }
            runCatching { Alarms.reschedule() }
            runCatching { Messages.refresh() }
            ackCommands(bundle.getJSONArray("commands"))
            true
        }.onFailure { Log.w(TAG, "kurallar alınamadı", it) }.getOrDefault(false)
    }

    private fun ackCommands(a: JSONArray) {
        val fresh = (0 until a.length()).map { a.getJSONObject(it) }.filter { it.isNull("acked_at") }
        val ids = fresh.map { it.getString("id") }
        if (ids.isEmpty()) return
        // Ebeveyn panelden "güncellemeyi şimdi kontrol et" dediyse bir sonraki turda hemen kontrol edilir
        if (fresh.any { it.optJSONObject("payload")?.optBoolean("update") == true }) Store.lastUpdateCheck = 0
        // Panel kasa anahtarı istiyor (yeni ebeveyn cihazı)
        if (fresh.any { it.optJSONObject("payload")?.optBoolean("vault") == true }) Vault.shareSoon()
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

    /** Gün sonunda kullanılmayan hakkı kasaya tek seferlik yaz. */
    fun storeDailySurplus(day: java.time.LocalDate, minutes: Int): Boolean = runCatching {
        if (minutes > 0) Api.rpc("device_store_daily_surplus", JSONObject().put("p_day", day.toString()).put("p_minutes", minutes))
        true
    }.onFailure { Log.w(TAG, "artan süre kasaya yazılamadı", it) }.getOrDefault(false)

    /** Kanıt dosyasını yükler ve görev kaydına ekler. */
    fun uploadProof(runId: String, stage: String, media: String, bytes: ByteArray, contentType: String) {
        val c = Store.creds ?: throw Api.ApiError(401, "Eşleşmemiş")
        val ext = if (media == "video") "mp4" else "jpg"
        val path = "${c.familyId}/$runId/${stage}-${System.currentTimeMillis()}.$ext"
        Api.upload("orbit-proofs", path, bytes, contentType)
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
