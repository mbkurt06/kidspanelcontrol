package app.orbit.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * Görev oturumu: çocuk görevi başlattığında (ya da ekran kaydı sürerken) telefonda yalnızca
 * Orbit ve görevin izinli uygulamaları açık kalır; bu sürede kullanım süreden düşmez.
 * Duraklatınca / bitirince telefon normal kurallara döner.
 */
object TaskSession {
    data class S(val runId: String, val title: String, val packages: Set<String>, val since: Long, val screen: Boolean)

    @Volatile private var cur: S? = null
        set(v) { field = v; flow.value = v }
    /** Ekranlar için */
    val flow = kotlinx.coroutines.flow.MutableStateFlow<S?>(null)
    @Volatile private var loaded = false

    fun current(): S? {
        if (!loaded) {
            loaded = true
            cur = runCatching {
                Store.prefs().getString("taskSession", null)?.let { j ->
                    val o = JSONObject(j)
                    val a = o.getJSONArray("p")
                    S(o.getString("r"), o.optString("t"), (0 until a.length()).map { a.getString(it) }.toSet(), o.optLong("s"), o.optBoolean("sc"))
                }
            }.getOrNull()
        }
        return cur
    }

    fun start(runId: String, title: String, packages: Collection<String>, screen: Boolean) {
        if (packages.isEmpty()) return
        val s = S(runId, title, packages.toSet(), System.currentTimeMillis(), screen)
        cur = s
        loaded = true
        runCatching {
            Store.prefs().edit().putString("taskSession", JSONObject().put("r", s.runId).put("t", s.title).put("p", JSONArray(s.packages.toList())).put("s", s.since).put("sc", screen).toString()).apply()
        }
        app.orbit.service.Live.syncRequested = true
    }

    fun stop(runId: String? = null) {
        val c = current() ?: return
        if (runId != null && c.runId != runId) return
        cur = null
        runCatching { Store.prefs().edit().remove("taskSession").apply() }
        app.orbit.service.Live.syncRequested = true
    }

    fun activeFor(runId: String) = current()?.runId == runId
}
