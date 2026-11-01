package app.orbit.data

import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.spec.MGF1ParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

/**
 * Şifre kasası — telefon tarafı (panel ile aynı biçim):
 * - Kasa anahtarı AES-256-GCM; her sahip için RSA-OAEP (SHA-256, MGF1 SHA-256) ile şifreli kopya.
 * - Bu telefonun RSA özel anahtarı uygulamanın özel alanında durur (çocuk erişemez).
 * - Kayıt: JSON → AES-GCM, 12 bayt IV, base64.
 */
object Vault {
    private const val TAG = "OrbitVault"
    private val rnd = SecureRandom()
    private val OAEP = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT)

    data class Entry(
        val id: String?,
        val app: String,
        val username: String,
        val password: String,
        val recovery: String,
        val note: String,
        val history: JSONArray = JSONArray(),
        val updatedBy: String = "phone",
    )

    fun b64(b: ByteArray): String = Base64.encodeToString(b, Base64.NO_WRAP)
    fun unb64(s: String): ByteArray = Base64.decode(s, Base64.DEFAULT)

    // --- bu telefonun sahip anahtarı ---

    private fun keyPair(): Pair<PublicKey, PrivateKey> {
        val p = Store.prefs()
        val pub = p.getString("vaultPub", null)
        val priv = p.getString("vaultPriv", null)
        if (pub != null && priv != null) {
            val kf = KeyFactory.getInstance("RSA")
            return kf.generatePublic(X509EncodedKeySpec(unb64(pub))) to kf.generatePrivate(PKCS8EncodedKeySpec(unb64(priv)))
        }
        val g = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }
        val kp = g.generateKeyPair()
        p.edit().putString("vaultPub", b64(kp.public.encoded)).putString("vaultPriv", b64(kp.private.encoded)).remove("vaultHolder").apply()
        return kp.public to kp.private
    }

    /** Sunucudaki sahip kaydını hazırlar; kimliğini döndürür. */
    fun ensureHolder(): String {
        val c = Store.creds ?: throw Api.ApiError(401, "Eşleşmemiş")
        Store.prefs().getString("vaultHolder", null)?.let { return it }
        val (pub, _) = keyPair()
        val existing = Api.get("vault_holders?device_id=eq.${c.deviceId}&select=id,public_key")
        val id = if (existing.length() > 0) {
            existing.getJSONObject(0).getString("id")
        } else {
            Api.post("vault_holders", JSONObject()
                .put("family_id", c.familyId).put("kind", "phone").put("device_id", c.deviceId)
                .put("child_id", c.childId).put("public_key", b64(pub.encoded)).put("label", android.os.Build.MODEL))
            Api.get("vault_holders?device_id=eq.${c.deviceId}&select=id").getJSONObject(0).getString("id")
        }
        Store.prefs().edit().putString("vaultHolder", id).apply()
        return id
    }

    private fun wrapFor(publicKeyB64: String, raw: ByteArray): String {
        val pub = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(unb64(publicKeyB64)))
        val c = Cipher.getInstance("RSA/ECB/OAEPPadding").apply { init(Cipher.ENCRYPT_MODE, pub, OAEP) }
        return b64(c.doFinal(raw))
    }

    private fun unwrap(wrapped: String): ByteArray {
        val (_, priv) = keyPair()
        val c = Cipher.getInstance("RSA/ECB/OAEPPadding").apply { init(Cipher.DECRYPT_MODE, priv, OAEP) }
        return c.doFinal(unb64(wrapped))
    }

    // --- kasa anahtarı ---

    sealed class State {
        data object None : State()
        data object Locked : State()
        data class Open(val key: ByteArray) : State()
    }

    private val sharing = java.util.concurrent.atomic.AtomicBoolean(false)

    /** Yeni bir ebeveyn cihazı anahtar istedi: kısa bir beklemeden sonra paylaş (aynı anda tek iş). */
    fun shareSoon() {
        if (!sharing.compareAndSet(false, true)) return
        Thread {
            try {
                Thread.sleep(1500)
                runCatching { open() }.onFailure { Log.w(TAG, "anlık paylaşım", it) }
            } finally {
                sharing.set(false)
            }
        }.start()
    }

    fun open(): State {
        val c = Store.creds ?: return State.Locked
        val me = ensureHolder()
        val keys = Api.get("vault_keys?child_id=eq.${c.childId}&select=holder_id,wrapped_key")
        for (i in 0 until keys.length()) {
            val k = keys.getJSONObject(i)
            if (k.getString("holder_id") == me) {
                val raw = runCatching { unwrap(k.getString("wrapped_key")) }.getOrNull() ?: return State.Locked
                runCatching { shareMissing(raw) }.onFailure { Log.w(TAG, "paylaşım", it) }
                return State.Open(raw)
            }
        }
        return if (keys.length() > 0) State.Locked else State.None
    }

    /** Kasa yoksa telefon oluşturur (kurtarma kodunu ebeveyn panelden ekler). */
    fun create(): ByteArray {
        val c = Store.creds ?: throw Api.ApiError(401, "Eşleşmemiş")
        val me = ensureHolder()
        val raw = ByteArray(32).also { rnd.nextBytes(it) }
        val pub = Store.prefs().getString("vaultPub", "")!!
        Api.post("vault_keys", JSONObject().put("child_id", c.childId).put("holder_id", me).put("wrapped_key", wrapFor(pub, raw)))
        shareMissing(raw)
        return raw
    }

    /** Anahtarı, anahtarı olmayan ebeveyn cihazlarına paylaştırır. */
    fun shareMissing(raw: ByteArray) {
        val c = Store.creds ?: return
        val holders = Api.get("vault_holders?select=id,kind,child_id,public_key")
        val keys = Api.get("vault_keys?child_id=eq.${c.childId}&select=holder_id")
        val have = (0 until keys.length()).map { keys.getJSONObject(it).getString("holder_id") }.toSet()
        for (i in 0 until holders.length()) {
            val h = holders.getJSONObject(i)
            val id = h.getString("id")
            if (id in have) continue
            if (h.optString("kind") == "phone" && h.optString("child_id") != c.childId) continue
            runCatching {
                Api.post("vault_keys", JSONObject().put("child_id", c.childId).put("holder_id", id).put("wrapped_key", wrapFor(h.getString("public_key"), raw)))
            }
        }
    }

    // --- kayıtlar ---

    private fun aes(mode: Int, key: ByteArray, iv: ByteArray): Cipher =
        Cipher.getInstance("AES/GCM/NoPadding").apply { init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv)) }

    fun decrypt(key: ByteArray, o: JSONObject): Entry? = runCatching {
        val plain = aes(Cipher.DECRYPT_MODE, key, unb64(o.getString("iv"))).doFinal(unb64(o.getString("ciphertext")))
        val j = JSONObject(String(plain, Charsets.UTF_8))
        Entry(
            o.getString("id"), j.optString("app"), j.optString("username"), j.optString("password"),
            j.optString("recovery"), j.optString("note"), j.optJSONArray("history") ?: JSONArray(), o.optString("updated_by", "phone"),
        )
    }.getOrNull()

    private fun encrypt(key: ByteArray, e: Entry): Pair<String, String> {
        val iv = ByteArray(12).also { rnd.nextBytes(it) }
        val j = JSONObject().put("app", e.app).put("username", e.username).put("password", e.password)
            .put("recovery", e.recovery).put("note", e.note).put("history", e.history)
        val ct = aes(Cipher.ENCRYPT_MODE, key, iv).doFinal(j.toString().toByteArray(Charsets.UTF_8))
        return b64(iv) to b64(ct)
    }

    fun list(key: ByteArray): List<Entry> {
        val c = Store.creds ?: return emptyList()
        val a = Api.get("vault_entries?child_id=eq.${c.childId}&removed_at=is.null&select=id,iv,ciphertext,updated_by,updated_at")
        return (0 until a.length()).mapNotNull { decrypt(key, a.getJSONObject(it)) }.sortedBy { it.app.lowercase() }
    }

    fun save(key: ByteArray, e: Entry, previous: Entry?) {
        val c = Store.creds ?: return
        var history = e.history
        if (previous != null && previous.password.isNotEmpty() && previous.password != e.password) {
            val h = JSONArray().put(JSONObject().put("password", previous.password).put("changed_at", java.time.Instant.now().toString()))
            for (i in 0 until minOf(previous.history.length(), 9)) h.put(previous.history.get(i))
            history = h
        }
        val (iv, ct) = encrypt(key, e.copy(history = history))
        if (e.id == null) {
            Api.post("vault_entries", JSONObject().put("child_id", c.childId).put("iv", iv).put("ciphertext", ct).put("updated_by", "phone"))
        } else {
            Api.patch("vault_entries?id=eq.${e.id}", JSONObject().put("iv", iv).put("ciphertext", ct).put("updated_by", "phone")
                .put("updated_at", java.time.Instant.now().toString()))
        }
    }

    fun remove(id: String) {
        Api.patch("vault_entries?id=eq.$id", JSONObject().put("removed_at", java.time.Instant.now().toString()))
    }

    fun generatePassword(len: Int = 14): String {
        val sets = listOf("ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnpqrstuvwxyz", "23456789", "!@#$%*?-_")
        val all = sets.joinToString("")
        val chars = CharArray(len) { all[rnd.nextInt(all.length)] }
        sets.forEachIndexed { i, s -> chars[i] = s[rnd.nextInt(s.length)] }
        return chars.toList().shuffled(rnd).joinToString("")
    }
}
