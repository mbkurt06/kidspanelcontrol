package app.orbit.data

import org.json.JSONArray
import org.json.JSONObject

/** Çocuğun ekranındaki bir görev (sunucudaki device_tasks cevabından). */
data class TaskItem(
    val runId: String,
    val title: String,
    val description: String?,
    val status: String,
    val rejectNote: String?,
    /** none | photo | video | photo_or_video */
    val proof: String,
    val beforeAfter: Boolean,
    val rewardMinutes: Int?,
    val rewardText: String?,
    val rewardValidity: String,
    val mandatory: Boolean,
    val dueTime: String?,
    val dueDate: String?,
    val createdAt: String?,
    val firstWins: Boolean,
    val hasBefore: Boolean,
    val hasAfter: Boolean,
    /** Kamera kaydı: süre (dk); null = kayıt yok */
    val recordMinutes: Int? = null,
    /** back | front | choose */
    val recordCamera: String = "back",
    /** none | limit | child */
    val recordPause: String = "child",
    val recordPauseMax: Int? = null,
    /** Şimdiki denemenin kaydı: id, durum (recording | paused | done), kaydedilen saniye */
    val recId: String? = null,
    val recStatus: String? = null,
    val recSeconds: Int = 0,
) {
    val needsRecording get() = recordMinutes != null
    val recordingDone get() = recStatus == "done"
    val open get() = status in setOf("open", "started", "rejected")
    val needsProof get() = proof != "none"
    /** Zorunlu ve henüz gönderilmemiş */
    val blocking get() = mandatory && status in setOf("open", "started", "rejected")
}

object Tasks {
    private fun JSONObject.s(k: String): String? = if (isNull(k) || !has(k)) null else optString(k).ifBlank { null }

    fun parse(a: JSONArray?): List<TaskItem> = (0 until (a?.length() ?: 0)).map { i ->
        val o = a!!.getJSONObject(i)
        val proofs = o.optJSONArray("proofs") ?: JSONArray()
        val stages = (0 until proofs.length()).map { proofs.getJSONObject(it).optString("stage") }
        TaskItem(
            runId = o.getString("run_id"),
            title = o.optString("title"),
            description = o.s("description"),
            status = o.optString("status"),
            rejectNote = o.s("reject_note"),
            proof = o.optString("proof", "none"),
            beforeAfter = o.optBoolean("before_after"),
            rewardMinutes = if (o.isNull("reward_minutes")) null else o.optInt("reward_minutes"),
            rewardText = o.s("reward_text"),
            rewardValidity = o.optString("reward_validity", "today"),
            mandatory = o.optBoolean("mandatory"),
            dueTime = o.s("due_time")?.take(5),
            dueDate = o.s("due_date"),
            createdAt = o.s("created_at"),
            firstWins = o.optString("assign_mode") == "first",
            hasBefore = "before" in stages,
            hasAfter = "after" in stages || "single" in stages,
            recordMinutes = if (o.isNull("record_minutes") || !o.has("record_minutes")) null else o.optInt("record_minutes"),
            recordCamera = o.optString("record_camera", "back"),
            recordPause = o.optString("record_pause", "child"),
            recordPauseMax = if (o.isNull("record_pause_max") || !o.has("record_pause_max")) null else o.optInt("record_pause_max"),
            recId = o.optJSONObject("recording")?.optString("id"),
            recStatus = o.optJSONObject("recording")?.optString("status"),
            recSeconds = o.optJSONObject("recording")?.optInt("recorded_seconds") ?: 0,
        )
    }

    fun current(): List<TaskItem> = parse(Store.rulesJson?.let { runCatching { JSONObject(it).optJSONArray("tasks") }.getOrNull() })
}
