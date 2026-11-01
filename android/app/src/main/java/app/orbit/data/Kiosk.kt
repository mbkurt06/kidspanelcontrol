package app.orbit.data

import android.util.Log
import org.json.JSONObject
import java.security.MessageDigest

/** Ebeveyn PIN'i: telefonda girilince tam kilit ve bütün sınırlamalar bir süre kalkar (ebeveyn modu). */
object Kiosk {
    private const val TAG = "OrbitKiosk"
    const val PIN_UNLOCK_MS = 15 * 60_000L

    fun hash(childId: String, pin: String): String =
        MessageDigest.getInstance("SHA-256").digest("$childId:$pin".toByteArray()).joinToString("") { "%02x".format(it) }

    /** PIN ile açılmışsa bitiş zamanı (ms), değilse null */
    fun pinUntil(): Long? = Store.prefs().getLong("pinUntil", 0L).takeIf { it > System.currentTimeMillis() }

    fun lockAgain() {
        Store.prefs().edit().putLong("pinUntil", 0L).apply()
    }

    /** IO iş parçacığında çağrılmaz; ağ olayı arka planda gönderilir. Doğruysa true. */
    fun tryPin(pin: String): Boolean {
        val c = Store.creds ?: return false
        val want = Store.rules().pinHash ?: return false
        val ok = hash(c.childId, pin.trim()) == want
        if (ok) Store.prefs().edit().putLong("pinUntil", System.currentTimeMillis() + PIN_UNLOCK_MS).apply()
        Thread {
            runCatching {
                Api.rpc("device_event", JSONObject().put("p_type", if (ok) "pin_unlock" else "pin_fail")
                    .put("p_payload", JSONObject().put("minutes", PIN_UNLOCK_MS / 60_000)))
            }.onFailure { Log.w(TAG, "olay gönderilemedi", it) }
        }.start()
        return ok
    }
}
