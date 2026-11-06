package app.orbit

import android.app.Application
import app.orbit.data.Store
import app.orbit.service.OrbitService

class OrbitApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Store.init(this)
        app.orbit.data.Recorder.init(this)
        app.orbit.data.Wifi.init(this)
        OrbitService.start(this)
    }
}
