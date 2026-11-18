package app.orbit

import android.app.Application
import app.orbit.data.Store
import app.orbit.service.OrbitService

class OrbitApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Gecko (Orbit içi tarayıcı) kendi yan işlemlerini (sekme, GPU, ağ) açar; onlarda Orbit başlatılmaz.
        // Başlatılırsa izole işlemde ayar dosyası açılamaz ve "Orbit sürekli duruyor" hatası çıkar.
        if (getProcessName() != packageName) return
        // Çökme olursa kısa özeti sakla; servis bir sonraki açılışta panele "app_crash" olayı olarak gönderir
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            runCatching {
                getSharedPreferences("orbit_crash", MODE_PRIVATE).edit()
                    .putString("last", "${t.name}: ${android.util.Log.getStackTraceString(e).take(3000)}").commit()
            }
            prev?.uncaughtException(t, e)
        }
        Store.init(this)
        app.orbit.data.Recorder.init(this)
        app.orbit.data.Wifi.init(this)
        OrbitService.start(this)
    }
}
