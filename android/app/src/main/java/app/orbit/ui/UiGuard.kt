package app.orbit.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import java.util.concurrent.atomic.AtomicInteger

/**
 * Çocuk Orbit'te bir iş yaparken (not / görev formu, fotoğraf çekme, yazı yazma) ebeveynden gelen
 * değişiklikler (onay, süre, kilit modu) ekranı değiştirmesin, formu kapatmasın.
 *  - hold(): açık bir form ya da Orbit'in kendi alt ekranı (kamera, kasa…)
 *  - touch(): son dokunuş; 15 sn içinde ekran değişikliği ertelenir
 *  - allowExternal(): Orbit'in açtığı dış ekran (galeri, dosya seçici) kısa süre kapatılmaz
 */
object UiGuard {
    private val holds = AtomicInteger(0)
    @Volatile private var lastTouch = 0L
    @Volatile private var externalUntil = 0L
    /** Ertelenen "şu ekranı aç" isteği (bildirime basıldı ama çocuk bir iş yapıyordu) */
    @Volatile var pendingScreen: String? = null

    fun hold() { holds.incrementAndGet() }
    fun release() { if (holds.decrementAndGet() < 0) holds.set(0) }
    fun touch() { lastTouch = System.currentTimeMillis() }
    fun holding(): Boolean = holds.get() > 0
    fun busy(now: Long = System.currentTimeMillis()): Boolean = holding() || now - lastTouch < 15_000
    fun allowExternal(ms: Long = 5 * 60_000L) { externalUntil = System.currentTimeMillis() + ms }
    fun external(now: Long = System.currentTimeMillis()): Boolean = now < externalUntil
    fun endExternal() { externalUntil = 0L }
}

/** Bu bileşen ekrandayken (ör. açık form) ebeveyn değişiklikleri ekranı değiştirmez */
@Composable
fun HoldUi() {
    DisposableEffect(Unit) {
        UiGuard.hold()
        onDispose { UiGuard.release() }
    }
}
