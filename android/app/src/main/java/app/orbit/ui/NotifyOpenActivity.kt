package app.orbit.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import app.orbit.data.Notifier

/**
 * Bildirime basınca önce buraya gelinir. Çocuk Orbit'te bir iş yapıyorsa (form, kamera) o ekran kapanmaz:
 * Orbit öne gelir, açık iş olduğu gibi kalır. Değilse istenen ekran açılır.
 */
class NotifyOpenActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!UiGuard.holding()) {
            runCatching {
                startActivity(Intent(this, MainActivity::class.java)
                    .putExtra(Notifier.EXTRA_SCREEN, intent.getStringExtra(Notifier.EXTRA_SCREEN))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            }
        }
        finish()
        @Suppress("DEPRECATION") overridePendingTransition(0, 0)
    }
}
