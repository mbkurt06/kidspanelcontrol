package app.orbit.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import app.orbit.data.Store
import app.orbit.data.Sync
import org.json.JSONObject
import kotlin.concurrent.thread

/** Telefon açılınca veya Orbit güncellenince servisi başlatır; açılışı ebeveyne bildirir. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Store.init(context)
        OrbitService.start(context)
        if (intent.action == Intent.ACTION_BOOT_COMPLETED && Store.creds != null) {
            val pending = goAsync()
            thread {
                try {
                    Sync.event("device_boot", JSONObject())
                } finally {
                    pending.finish()
                }
            }
        }
    }
}

/**
 * Kurulum günü bilgisayardan (adb) ayar göndermek için. Sadece adb kabuğu (DUMP izni) kullanabilir.
 * Örnek: adb shell am broadcast -a app.orbit.CONFIG -n app.orbit/.service.ConfigReceiver --es token XXXX
 */
class ConfigReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Store.init(context)
        intent.getStringExtra("token")?.let { Store.updateToken = it.trim() }
    }
}
