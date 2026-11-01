package app.orbit.data

import android.util.Log
import org.json.JSONObject
import java.security.MessageDigest

/** Ebeveyn PIN'i: telefonda girilince tam kilit ve bütün sınırlamalar bir süre kalkar (ebeveyn modu). */
object Kiosk {
    private const val TAG = "OrbitKiosk"
    fun hash(familyId: String, pin: String): String =
        MessageDigest.getInstance("SHA-256").digest("orbit:$familyId:$pin".toByteArray()).joinToString("") { "%02x".format(it) }

    /** 3 yanlış denemeden sonra 5 dk bekleme; kalan bekleme (ms) */
    fun waitMs(): Long = (Store.prefs().getLong("pinBlockedUntil", 0L) - System.currentTimeMillis()).coerceAtLeast(0)

    /** PIN ile açılmışsa bitiş zamanı (ms), değilse null */
    fun pinUntil(): Long? = Store.prefs().getLong("pinUntil", 0L).takeIf { it > System.currentTimeMillis() }

    fun lockAgain() {
        Store.prefs().edit().putLong("pinUntil", 0L).apply()
    }

    /** IO iş parçacığında çağrılmaz; ağ olayı arka planda gönderilir. Doğruysa true. */
    fun tryPin(pin: String): Boolean {
        if (waitMs() > 0) return false
        val rules = Store.rules()
        val want = rules.pinHash ?: return false
        val ok = hash(rules.familyId, pin.trim()) == want
        val p = Store.prefs()
        val minutes = rules.pinMinutes
        if (ok) {
            p.edit().putLong("pinUntil", System.currentTimeMillis() + minutes * 60_000L).putInt("pinFails", 0).apply()
        } else {
            val fails = p.getInt("pinFails", 0) + 1
            val e = p.edit().putInt("pinFails", fails)
            if (fails >= 3) e.putInt("pinFails", 0).putLong("pinBlockedUntil", System.currentTimeMillis() + 5 * 60_000L)
            e.apply()
        }
        Thread {
            runCatching {
                Api.rpc("device_event", JSONObject().put("p_type", if (ok) "pin_unlock" else "pin_fail")
                    .put("p_payload", JSONObject().put("minutes", minutes)))
            }.onFailure { Log.w(TAG, "olay gönderilemedi", it) }
        }.start()
        return ok
    }
}
