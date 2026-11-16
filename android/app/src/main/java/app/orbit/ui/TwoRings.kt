package app.orbit.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.Store
import app.orbit.engine.KioskNow
import app.orbit.engine.Snapshot
import app.orbit.engine.UNLIMITED_SECONDS
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

/** Telefonun açıklık durumu: açıksa kaç dk açık kalacak, kilitliyse ne zaman açılacak */
data class Openness(val locked: Boolean, val untilMs: Long?, val openLeftSec: Long?)

fun openness(s: Snapshot, k: KioskNow?): Openness {
    val zone = ZoneId.of(Store.rules().timezone)
    val now = ZonedDateTime.now(zone)
    fun nextAt(t: java.time.LocalTime): Long {
        var z = now.toLocalDate().atTime(t).atZone(zone)
        if (!z.isAfter(now)) z = z.plusDays(1)
        return z.toInstant().toEpochMilli()
    }
    if (k != null) return Openness(true, k.untilMs, null)
    val sec = s.section
    if (s.locked) return Openness(true, s.lockUntil ?: sec?.let { nextAt(it.endsAt) }, null)
    if (s.sectionMode && (sec == null || s.sectionClosed)) return Openness(true, sec?.let { nextAt(it.endsAt) }, null)
    val end = s.modeEndsAt ?: sec?.endsAt ?: return Openness(false, null, null)
    val ms = nextAt(end)
    return Openness(false, ms, ((ms - System.currentTimeMillis()) / 1000).coerceAtLeast(0))
}

private fun hhmm(ms: Long) = Instant.ofEpochMilli(ms).atZone(ZoneId.of(Store.rules().timezone)).toLocalTime().toString().take(5)

/** Gün bitişi (ör. 05:00) saat metni */
fun dayEndText(): String = Store.rules().dayEndMin.let { "%02d:%02d".format(it / 60, it % 60) }

/** Kilit gün bitişinden sonra mı bitiyor (ya da süresiz mi) */
fun lockPassesDayEnd(o: Openness, s: Snapshot): Boolean {
    if (!o.locked) return false
    val zone = ZoneId.of(Store.rules().timezone)
    val de = s.day.plusDays(1).atStartOfDay(zone).plusMinutes(Store.rules().dayEndMin.toLong()).toInstant().toEpochMilli()
    return o.untilMs == null || o.untilMs >= de
}

/** İki halka: solda bugünkü süren (hak), sağda telefonun açıklığı / kilidi */
@Composable
fun TwoRings(s: Snapshot, k: KioskNow?) {
    val o = openness(s, k)
    val hak = s.dayLeftSeconds ?: s.remainingSeconds
    val unlimited = hak >= UNLIMITED_SECONDS
    val hakMin = hak / 60
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.Top) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            val frac = if (unlimited) 1f else if (s.allowanceMinutes > 0) hak / (s.allowanceMinutes * 60f) else if (hak > 0) 1f else 0f
            Ring(frac, if (unlimited || hak > 600) C.blue else C.warn, 110.dp) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(if (unlimited) "∞" else minutesText(hakMin), color = C.text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    Muted(if (unlimited) "sınırsız" else "kaldı", 12)
                }
            }
            Muted("Bugünkü süren", 13)
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            if (o.locked) {
                Ring(1f, C.bad, 110.dp) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("🔒", fontSize = 22.sp)
                        Muted(o.untilMs?.let { hhmm(it) + "'e kadar" } ?: "ebeveyn açar", 12)
                    }
                }
            } else {
                val left = o.openLeftSec
                val short = left != null && !unlimited && left < hak
                val frac = if (left == null) 1f else if (unlimited) 1f else (left.toFloat() / maxOf(left, hak).coerceAtLeast(1)).coerceIn(0f, 1f)
                Ring(frac, if (short) C.warn else C.accent, 110.dp) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(left?.let { minutesText(it / 60) } ?: "açık", color = C.text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                        Muted(o.untilMs?.let { hhmm(it) + "'e kadar" } ?: "", 12)
                    }
                }
            }
            Muted("Telefon", 13)
        }
    }
    if (!unlimited && hakMin > 0) {
        val text = when {
            o.locked && lockPassesDayEnd(o, s) ->
                "Bugünkü ${minutesText(hakMin)}'n gece ${dayEndText()}'te kasaya geçer." +
                    (o.untilMs?.let { " Telefon ${hhmm(it)}'te açılınca yeni günün süresi başlar." } ?: "") +
                    " Bu ${minutesText(hakMin)}'yı ancak ebeveynin kilidi ${dayEndText()}'ten önce açarsa kullanabilirsin."
            o.locked -> "Süren bekliyor; telefon açılınca kullanabilirsin."
            o.openLeftSec != null && o.openLeftSec < hak ->
                "Telefon ${minutesText(o.openLeftSec / 60)} sonra kapanacak; kalan süren ${dayEndText()}'e kadar bekler, sonra kasaya geçer."
            else -> null
        }
        text?.let { Text(it, color = C.muted, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) }
    }
}
