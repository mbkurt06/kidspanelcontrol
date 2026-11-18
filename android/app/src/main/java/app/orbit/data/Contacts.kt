package app.orbit.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray

/** Kişiler: panelden eklenen anne/baba numarası ve önemli bilgiler (Orbit ana ekranında, kilitliyken de) */
object Contacts {
    data class Contact(val id: String, val name: String, val emoji: String, val value: String)

    private val _list = MutableStateFlow<List<Contact>>(emptyList())
    val list: StateFlow<List<Contact>> = _list.asStateFlow()

    fun init() {
        if (_list.value.isEmpty()) runCatching { Store.prefs().getString("contacts.cache", null)?.let { _list.value = parse(JSONArray(it)) } }
    }

    fun store(arr: JSONArray) {
        _list.value = parse(arr)
        runCatching { Store.prefs().edit().putString("contacts.cache", arr.toString()).apply() }
    }

    private fun parse(a: JSONArray) = (0 until a.length()).mapNotNull { i ->
        val o = a.optJSONObject(i) ?: return@mapNotNull null
        Contact(o.optString("id"), o.optString("name"), o.optString("emoji", "👤"), o.optString("value"))
    }

    var collapsed: Boolean
        get() = runCatching { Store.prefs().getBoolean("contacts.collapsed", false) }.getOrDefault(false)
        set(v) { runCatching { Store.prefs().edit().putBoolean("contacts.collapsed", v).apply() } }
}
