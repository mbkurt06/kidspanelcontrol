package app.orbit.data

import android.content.Context
import android.content.SharedPreferences
import app.orbit.engine.DayUsage
import app.orbit.engine.Rules
import org.json.JSONObject
import java.time.LocalDate

/**
 * Telefondaki kalıcı kayıtlar. Uygulama verisi Android'in uygulamaya özel alanında durur;
 * çocuk bu alana erişemez (device owner geliştirici seçeneklerini ve adb'yi kapatır).
 */
object Store {
    private lateinit var p: SharedPreferences

    fun init(ctx: Context) {
        if (!::p.isInitialized) p = ctx.applicationContext.getSharedPreferences("orbit", Context.MODE_PRIVATE)
    }

    fun prefs(): SharedPreferences = p

    // --- Eşleştirme / oturum ---
    data class Creds(val deviceId: String, val childId: String, val familyId: String, val email: String, val password: String)

    var creds: Creds?
        get() {
            val e = p.getString("email", null) ?: return null
            return Creds(p.getString("deviceId", "")!!, p.getString("childId", "")!!, p.getString("familyId", "")!!, e, p.getString("password", "")!!)
        }
        set(c) {
            p.edit().apply {
                if (c == null) {
                    remove("deviceId"); remove("childId"); remove("familyId"); remove("email"); remove("password")
                    remove("accessToken"); remove("refreshToken"); remove("tokenExpiry")
                } else {
                    putString("deviceId", c.deviceId); putString("childId", c.childId); putString("familyId", c.familyId)
                    putString("email", c.email); putString("password", c.password)
                }
            }.apply()
        }

    var accessToken: String?
        get() = p.getString("accessToken", null)
        set(v) = p.edit().putString("accessToken", v).apply()
    var refreshToken: String?
        get() = p.getString("refreshToken", null)
        set(v) = p.edit().putString("refreshToken", v).apply()
    var tokenExpiry: Long
        get() = p.getLong("tokenExpiry", 0)
        set(v) = p.edit().putLong("tokenExpiry", v).apply()

    var childName: String
        get() = p.getString("childName", "") ?: ""
        set(v) = p.edit().putString("childName", v).apply()

    // --- Kurallar ---
    @Volatile
    private var rulesCache: Rules? = null

    var rulesJson: String?
        get() = p.getString("rules", null)
        set(v) {
            p.edit().putString("rules", v).apply()
            rulesCache = null
        }

    fun rules(): Rules {
        rulesCache?.let { return it }
        val r = rulesJson?.let { runCatching { Parse.rulesFromBundle(JSONObject(it)) }.getOrNull() } ?: Rules()
        rulesCache = r
        return r
    }

    var lastSync: Long
        get() = p.getLong("lastSync", 0)
        set(v) = p.edit().putLong("lastSync", v).apply()

    // --- Gün sayaçları ---
    fun usage(day: LocalDate): DayUsage {
        val s = p.getString("usage", null)
        val u = s?.let { runCatching { Parse.usageFromJson(it) }.getOrNull() }
        return if (u != null && u.day == day) u else DayUsage(day)
    }

    /** Gün değiştiyse dünkü sayaçları "gönderilecek" olarak ayır. */
    fun rollover(today: LocalDate) {
        val s = p.getString("usage", null) ?: return
        val u = runCatching { Parse.usageFromJson(s) }.getOrNull() ?: return
        if (u.day != today) {
            savePreviousUsage(u)
            saveUsage(DayUsage(today))
        }
    }

    fun saveUsage(u: DayUsage) = p.edit().putString("usage", Parse.usageToJson(u)).apply()

    /** Dünün sayaçları (gece yarısından sonra sunucuya son kez gönderilsin diye). */
    fun previousUsage(): DayUsage? = p.getString("usagePrev", null)?.let { runCatching { Parse.usageFromJson(it) }.getOrNull() }
    fun savePreviousUsage(u: DayUsage?) = p.edit().putString("usagePrev", u?.let { Parse.usageToJson(it) }).apply()

    // --- Güncelleme ---
    var updateToken: String
        get() = p.getString("updateToken", "") ?: ""
        set(v) = p.edit().putString("updateToken", v).apply()

    var lastUpdateCheck: Long
        get() = p.getLong("lastUpdateCheck", 0)
        set(v) = p.edit().putLong("lastUpdateCheck", v).apply()
}
