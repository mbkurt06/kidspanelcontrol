package app.orbit

import android.app.Application
import app.orbit.data.Store
import app.orbit.service.OrbitService

class OrbitApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Store.init(this)
        OrbitService.start(this)
    }
}
