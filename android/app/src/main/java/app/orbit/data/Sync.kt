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
            val fam = Api.get("families?select=timezone&limit=1")
            val kid = Api.get("children?select=name&id=eq.$child")
            val bundle = JSONObject()
                .put("timezone", fam.optJSONObject(0)?.optString("timezone") ?: "Europe/Berlin")
                .put("apps", Api.get("child_apps?child_id=eq.$child&select=package,label,app_group,approved,daily_limit_minutes"))
                .put("profiles", Api.get("rule_profiles?select=*"))
                .put("modes", Api.get("modes?select=*"))
                .put("slots", Api.get("mode_slots?select=*"))
                .put("assignments", Api.get("profile_assignments?child_id=eq.$child&select=weekday,profile_id"))
                .put("overrides", Api.get("day_overrides?child_id=eq.$child&select=*"))
                .put("grants", Api.get("time_grants?child_id=eq.$child&select=*&order=created_at.desc&limit=100"))
                .put("commands", Api.get("commands?child_id=eq.$child&select=*&order=created_at.desc&limit=60"))
            Store.rulesJson = bundle.toString()
            kid.optJSONObject(0)?.optString("name")?.let { Store.childName = it }
            Store.lastSync = System.currentTimeMillis()
            ackCommands(bundle.getJSONArray("commands"))
            true
        }.onFailure { Log.w(TAG, "kurallar alınamadı", it) }.getOrDefault(false)
    }

    private fun ackCommands(a: JSONArray) {
        val ids = (0 until a.length()).map { a.getJSONObject(it) }.filter { it.isNull("acked_at") }.map { it.getString("id") }
        if (ids.isEmpty()) return
        runCatching {
            Api.patch("commands?id=in.(${ids.joinToString(",")})", JSONObject().put("acked_at", Instant.now().toString()))
        }
    }

    /** Yüklü uygulamaları bildirir. İlk seferde temel uygulamalar onaylı ve "her zaman açık" gelir. */
    fun reportApps(ctx: Context, initial: Boolean) {
        val essentials = Policy.essentials(ctx)
        val arr = JSONArray()
        for (a in Policy.launchables(ctx)) {
            val o = JSONObject().put("package", a.pkg).put("label", a.label).put("system", a.system)
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
                    .put("current_mode_name", s.activeMode?.name ?: JSONObject.NULL)
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

    fun activateGrant(id: String, day: String): Boolean =
        runCatching { Api.patch("time_grants?id=eq.$id&activated_on=is.null", JSONObject().put("activated_on", day)); true }.getOrDefault(false)

    fun event(type: String, payload: JSONObject = JSONObject()): Boolean {
        val c = Store.creds ?: return false
        return runCatching {
            Api.post("events", JSONObject().put("family_id", c.familyId).put("child_id", c.childId).put("type", type).put("payload", payload))
            true
        }.onFailure { Log.w(TAG, "olay gönderilemedi", it) }.getOrDefault(false)
    }
}
