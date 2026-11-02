package app.orbit.data

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

data class AgendaItem(
    val id: String,
    val kind: String,
    val title: String,
    val note: String?,
    val enteredAt: String,
    val dueDate: String,
    val dueTime: String?,
    val amount: Double?,
    val currency: String,
    val status: String,
)

object Agenda {
    fun parse(a: JSONArray?): List<AgendaItem> = (0 until (a?.length() ?: 0)).mapNotNull { i ->
        val o = a?.optJSONObject(i) ?: return@mapNotNull null
        AgendaItem(
            o.optString("id"), o.optString("kind", "homework"), o.optString("title"),
            o.optString("note").takeIf { !o.isNull("note") && it.isNotBlank() },
            o.optString("entered_at"), o.optString("due_date"),
            o.optString("due_time").takeIf { !o.isNull("due_time") && it.isNotBlank() },
            if (o.isNull("amount") || !o.has("amount")) null else o.optDouble("amount"),
            o.optString("currency", "EUR"), o.optString("status", "open"),
        )
    }

    fun current(): List<AgendaItem> = Store.rules().agenda

    fun create(kind: String, title: String, note: String?, dueDate: String, dueTime: String?, amount: Double?, currency: String): Boolean {
        val c = Store.creds ?: return false
        return runCatching {
            Api.post(
                "agenda_items",
                JSONObject().put("family_id", c.familyId).put("child_id", c.childId).put("kind", kind)
                    .put("title", title).put("note", note ?: JSONObject.NULL).put("due_date", dueDate)
                    .put("due_time", dueTime ?: JSONObject.NULL).put("amount", amount ?: JSONObject.NULL).put("currency", currency),
            )
            true
        }.getOrDefault(false)
    }

    fun setDone(id: String, done: Boolean): Boolean = runCatching {
        Api.patch(
            "agenda_items?id=eq.$id",
            JSONObject().put("status", if (done) "done" else "open")
                .put("completed_at", if (done) Instant.now().toString() else JSONObject.NULL),
        )
        true
    }.getOrDefault(false)
}
