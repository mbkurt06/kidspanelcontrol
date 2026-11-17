package app.orbit.data

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

/** Notlar: ebeveynin tanımladığı dersler (sınıf düzeyine göre) ve çocuğun girdiği notlar (ebeveyn onaylar). */
object Grades {
    private const val TAG = "OrbitGrades"
    val KINDS = listOf("exam", "oral", "test", "homework")
    val KIND_TEXT = mapOf("exam" to "Sınav", "oral" to "Sözlü", "test" to "Test", "homework" to "Ödev")

    data class Subject(val id: String, val name: String, val color: String?, val level: Int, val weights: Map<String, Int>, val hiddenFor: Set<String>)
    data class Grade(
        val id: String, val subjectId: String, val level: Int, val kind: String, val grade: String, val value: Double,
        val takenOn: String, val note: String?, val photos: List<String>, val status: String, val rejectNote: String?,
    )
    data class State(val loaded: Boolean = false, val level: Int? = null, val subjects: List<Subject> = emptyList(), val grades: List<Grade> = emptyList(), val error: String? = null)

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun refresh() {
        val c = Store.creds ?: return
        runCatching {
            val lvl = Api.get("children?select=grade_level&id=eq.${c.childId}").optJSONObject(0)?.let { if (it.isNull("grade_level")) null else it.optInt("grade_level") }
            val subs = Api.get("subjects?select=*&order=sort.asc,created_at.asc").let { a ->
                (0 until a.length()).map { i -> a.getJSONObject(i) }.map { o ->
                    val w = o.optJSONObject("weights") ?: JSONObject()
                    Subject(
                        o.getString("id"), o.getString("name"), o.optString("color").ifBlank { null }, o.optInt("grade_level"),
                        w.keys().asSequence().associateWith { w.optInt(it) },
                        strs(o.optJSONArray("hidden_for")).toSet(),
                    )
                }.filter { c.childId !in it.hiddenFor }
            }
            val gs = Api.get("grades?child_id=eq.${c.childId}&select=*&order=taken_on.asc,created_at.asc").let { a ->
                (0 until a.length()).map { i -> a.getJSONObject(i) }.map { o ->
                    Grade(
                        o.getString("id"), o.getString("subject_id"), o.optInt("grade_level"), o.getString("kind"), o.getString("grade"),
                        o.optDouble("value"), o.getString("taken_on"), o.optString("note").ifBlank { null }.takeIf { !o.isNull("note") },
                        strs(o.optJSONArray("photos")), o.getString("status"), o.optString("reject_note").takeIf { !o.isNull("reject_note") && it.isNotBlank() },
                    )
                }
            }
            _state.value = State(true, lvl, subs, gs)
        }.onFailure {
            Log.w(TAG, "notlar alınamadı", it)
            _state.value = _state.value.copy(loaded = true, error = it.message)
        }
    }

    private fun strs(a: JSONArray?): List<String> = (0 until (a?.length() ?: 0)).map { a!!.getString(it) }

    /** Kâğıt fotoğrafı: OneDrive'da kalıcı klasöre (Orbit / çocuk / Notlar / sınıf / ders / tarih tür); bağlı değilse Orbit deposuna */
    fun uploadPhoto(bytes: ByteArray, level: Int, subject: String, takenOn: String, kind: String, page: Int): String {
        val c = Store.creds ?: throw Api.ApiError(401, "Eşleşmemiş")
        val folder = "Notlar/$level. sınıf/$subject/$takenOn ${KIND_TEXT[kind] ?: kind}"
        val name = "sayfa-$page.jpg"
        val od = runCatching { Cloud.uploadBytes(bytes, name, "image/jpeg", folder) }.onFailure { Cloud.log("OneDrive not yüklemesi", it) }.getOrNull()
        if (od != null) return "${c.familyId}/notlar/od:$od"
        val path = "${c.familyId}/notlar/${c.childId}/${takenOn}-${System.currentTimeMillis()}-$page.jpg"
        Api.upload("orbit-proofs", path, bytes, "image/jpeg")
        return path
    }

    fun save(id: String?, subjectId: String, kind: String, grade: String, takenOn: String, note: String?, photos: List<String>) {
        Api.rpc(
            "device_grade_save",
            JSONObject()
                .put("p_id", id ?: JSONObject.NULL).put("p_subject", subjectId).put("p_kind", kind).put("p_grade", grade)
                .put("p_taken_on", takenOn).put("p_note", note ?: JSONObject.NULL).put("p_photos", JSONArray(photos)),
        )
    }

    /** Ağırlıklı ortalama (sadece onaylı notlar): türlerin ortalaması yüzdelerle; ayar yoksa düz ortalama */
    fun average(list: List<Grade>, weights: Map<String, Int>): Double? {
        val ok = list.filter { it.status == "approved" }
        if (ok.isEmpty()) return null
        var sum = 0.0
        var w = 0
        for (k in KINDS) {
            val xs = ok.filter { it.kind == k }
            val wk = weights[k] ?: 0
            if (xs.isEmpty() || wk <= 0) continue
            sum += xs.sumOf { it.value } / xs.size * wk
            w += wk
        }
        return if (w > 0) sum / w else ok.sumOf { it.value } / ok.size
    }

    fun show(g: String) = g.replace("-", "−")
}
