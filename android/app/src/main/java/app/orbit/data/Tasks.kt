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
    val beforePhotoMin: Int,
    val beforePhotoMax: Int,
    val afterPhotoMin: Int,
    val afterPhotoMax: Int,
    val beforeCount: Int,
    val afterCount: Int,
    val rewardMinutes: Int?,
    val failMinutes: Int? = null,
    val rewardText: String?,
    val rewardValidity: String,
    val mandatory: Boolean,
    val dueTime: String?,
    val dueDate: String?,
    val createdAt: String?,
    val firstWins: Boolean,
    /** Kamera kaydı: süre (dk); null = kayıt yok */
    val recordMinutes: Int? = null,
    /** En az kayıt süresi (dk); null = sabit süre */
    val recordMinMinutes: Int? = null,
    /** Ekran görüntüsü kanıtı: en az / en fazla / şimdiye kadar eklenen */
    val screenshotMin: Int? = null,
    val screenshotMax: Int? = null,
    val screenshotCount: Int = 0,
    /** Ekran kaydı kanıtı: en fazla / en az (dk), son kaydın durumu ve süresi */
    val screenRecMinutes: Int? = null,
    val screenRecMinMinutes: Int? = null,
    val screenRecId: String? = null,
    val screenRecStatus: String? = null,
    val screenRecSeconds: Int = 0,
    /** Görev sürerken açık olan uygulamalar */
    val allowedPackages: List<String> = emptyList(),
    /** keep = o anki durumu koru, focus = görev sırasında sadece izinli uygulamalar */
    val allowedMode: String = "focus",
    /** Görev saat aralığı (HH:mm); dışında görev gizlenir */
    val windowStart: String? = null,
    /** Bağlı görevler: bağ numarası (1'den), boyutu, durumu */
    val bundlePos: Int? = null,
    val bundleSize: Int = 0,
    val bundleDone: Boolean = false,
    val bundleReady: Boolean = true,
    val bundleCurrent: Boolean = false,
    val bundleMinutes: Int = 0,
    val bundleHeld: Int = 0,
    val bundleOptional: Boolean = false,
    val windowEnd: String? = null,
    /** back | front | choose */
    val recordCamera: String = "back",
    /** none | limit | child */
    val recordPause: String = "child",
    val recordPauseMax: Int? = null,
    /** Şimdiki denemenin kaydı: id, durum (recording | paused | done), kaydedilen saniye */
    val recId: String? = null,
    val recStatus: String? = null,
    val recSeconds: Int = 0,
    val taskId: String = "",
    /** Görev grubu (yoksa null) */
    val groupId: String? = null,
    val groupName: String? = null,
    val sequential: Boolean = false,
    /** Sıralı grupta önceki görev onaylanmadıysa true */
    val locked: Boolean = false,
    val groupApproved: Int = 0,
    val groupNeed: Int = 0,
    val groupTotal: Int = 0,
    val groupHeld: Int = 0,
    val groupAll: Int = 0,
    val groupMandatoryLeft: Int = 0,
    /** open | met | failed */
    val groupStatus: String = "open",
    val agendaItemId: String? = null,
    /** Grubun başlangıç saati (HH:mm) */
    val startTime: String? = null,
) {
    val hasBefore get() = beforeCount > 0
    val hasAfter get() = afterCount > 0
    val needsRecording get() = recordMinutes != null
    val recordingDone get() = recStatus == "done"
    val open get() = status in setOf("open", "started", "rejected")
    val needsProof get() = proof != "none"
    val needsScreenshot get() = screenshotMin != null && screenshotCount < screenshotMin
    /** Görev saat aralığında mı (dışında açık görevler gizlenir) */
    fun inWindow(now: java.time.LocalTime = java.time.LocalTime.now()): Boolean {
        val a = windowStart?.let { runCatching { java.time.LocalTime.parse(it) }.getOrNull() } ?: return true
        val b = windowEnd?.let { runCatching { java.time.LocalTime.parse(it) }.getOrNull() } ?: return true
        return if (a < b) !now.isBefore(a) && now.isBefore(b) else !now.isBefore(a) || now.isBefore(b)
    }
    val needsScreenRec get() = screenRecMinutes != null && !(screenRecStatus == "done" && screenRecSeconds >= (screenRecMinMinutes ?: 0) * 60)
    /** Görevler artık tek başına süreli uygulamaları engellemez; kısıtlar odak profillerinden gelir. */
    val blocking get() = false
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
            beforePhotoMin = o.optInt("proof_before_min", if (o.optBoolean("before_after")) 1 else 0),
            beforePhotoMax = o.optInt("proof_before_max", 4),
            afterPhotoMin = o.optInt("proof_after_min", 1),
            afterPhotoMax = o.optInt("proof_after_max", 4),
            beforeCount = o.optInt("before_count", stages.count { it == "before" }),
            afterCount = o.optInt("after_count", stages.count { it == "after" || it == "single" }),
            rewardMinutes = if (o.isNull("reward_minutes")) null else o.optInt("reward_minutes"),
            failMinutes = o.optInt("fail_minutes", 0).takeIf { it > 0 },
            rewardText = o.s("reward_text"),
            rewardValidity = o.optString("reward_validity", "today"),
            mandatory = o.optBoolean("mandatory"),
            dueTime = o.s("due_time")?.take(5),
            dueDate = o.s("due_date"),
            createdAt = o.s("created_at"),
            firstWins = o.optString("assign_mode") == "first",
            recordMinutes = if (o.isNull("record_minutes") || !o.has("record_minutes")) null else o.optInt("record_minutes"),
            screenshotMin = if (o.isNull("screenshot_min") || !o.has("screenshot_min")) null else o.optInt("screenshot_min"),
            screenshotMax = if (o.isNull("screenshot_max") || !o.has("screenshot_max")) null else o.optInt("screenshot_max"),
            screenshotCount = stages.count { it == "screenshot" },
            screenRecMinutes = if (o.isNull("screen_record_minutes") || !o.has("screen_record_minutes")) null else o.optInt("screen_record_minutes"),
            screenRecMinMinutes = if (o.isNull("screen_record_min_minutes") || !o.has("screen_record_min_minutes")) null else o.optInt("screen_record_min_minutes"),
            screenRecId = o.optJSONObject("screen_recording")?.optString("id"),
            screenRecStatus = o.optJSONObject("screen_recording")?.optString("status"),
            screenRecSeconds = o.optJSONObject("screen_recording")?.optInt("recorded_seconds") ?: 0,
            allowedMode = o.optString("allowed_mode", "focus"),
            windowStart = o.s("window_start")?.take(5),
            bundlePos = o.optJSONObject("bundle")?.optInt("pos")?.takeIf { it > 0 },
            bundleSize = o.optJSONObject("bundle")?.optInt("size") ?: 0,
            bundleDone = o.optJSONObject("bundle")?.optBoolean("done") ?: false,
            bundleReady = o.optJSONObject("bundle")?.optBoolean("ready", true) ?: true,
            bundleCurrent = o.optJSONObject("bundle")?.optBoolean("current") ?: false,
            bundleMinutes = o.optJSONObject("bundle")?.optInt("minutes") ?: 0,
            bundleHeld = o.optJSONObject("bundle")?.optInt("held") ?: 0,
            bundleOptional = o.optJSONObject("bundle")?.optBoolean("optional") ?: false,
            windowEnd = o.s("window_end")?.take(5),
            allowedPackages = o.optJSONArray("allowed_packages")?.let { a -> (0 until a.length()).map { a.optString(it) }.filter { it.isNotBlank() } } ?: emptyList(),
            recordMinMinutes = if (o.isNull("record_min_minutes") || !o.has("record_min_minutes")) null else o.optInt("record_min_minutes"),
            recordCamera = o.optString("record_camera", "back"),
            recordPause = o.optString("record_pause", "child"),
            recordPauseMax = if (o.isNull("record_pause_max") || !o.has("record_pause_max")) null else o.optInt("record_pause_max"),
            recId = o.optJSONObject("recording")?.optString("id"),
            recStatus = o.optJSONObject("recording")?.optString("status"),
            recSeconds = o.optJSONObject("recording")?.optInt("recorded_seconds") ?: 0,
            taskId = o.optString("task_id"),
            groupId = o.s("group_id"),
            groupName = o.s("group_name"),
            sequential = o.optBoolean("sequential"),
            locked = o.optBoolean("locked"),
            groupApproved = o.optJSONObject("group")?.optInt("approved") ?: 0,
            groupNeed = o.optJSONObject("group")?.optInt("need") ?: 0,
            groupTotal = o.optJSONObject("group")?.optInt("total") ?: 0,
            groupHeld = o.optJSONObject("group")?.optInt("held_minutes") ?: 0,
            groupAll = o.optJSONObject("group")?.optInt("all_minutes") ?: 0,
            groupMandatoryLeft = o.optJSONObject("group")?.optInt("mandatory_left") ?: 0,
            groupStatus = o.optJSONObject("group")?.optString("status", "open") ?: "open",
            agendaItemId = o.s("agenda_item_id"),
            startTime = o.s("start_time")?.take(5),
        )
    }

    fun current(): List<TaskItem> = parse(Store.rulesJson?.let { runCatching { JSONObject(it).optJSONArray("tasks") }.getOrNull() })
}
