package app.orbit.device

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Bundle

/**
 * QR kodla kurulum (Android 12+): kurulum sihirbazı Orbit'e hangi modda kurulacağını sorar.
 * Orbit "tam yönetilen cihaz" (device owner) cevabını verir.
 */
class ProvisioningModeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_OK, Intent().putExtra(
            DevicePolicyManager.EXTRA_PROVISIONING_MODE,
            DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE,
        ))
        finish()
    }
}

/** Kurulumun son adımı: Orbit kuralları uygular ve sihirbaza "tamam" der. */
class PolicyComplianceActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        app.orbit.data.Store.init(this)
        runCatching { Policy.applyBase(this, maintenance = false) }
        setResult(RESULT_OK)
        finish()
    }
}
