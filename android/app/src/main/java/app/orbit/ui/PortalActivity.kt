package app.orbit.ui

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import app.orbit.data.Wifi
import kotlinx.coroutines.delay

/**
 * Onay sayfalı Wi-Fi (AVM, şehir ağları): giriş sayfasını Orbit kendi içinde açar.
 * Tarayıcı değildir: adres çubuğu yok, sadece http/https; internet gelince ya da 5 dk sonra kapanır.
 * Uygulama bu süre boyunca Wi-Fi ağına bağlanır (onaysız ağda mobil veri yerine).
 */
class PortalActivity : ComponentActivity() {
    private var bound = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val net = Wifi.wifiNetwork
        if (net == null) { finish(); return }
        val cm = getSystemService(ConnectivityManager::class.java)
        bound = runCatching { cm.bindProcessToNetwork(net) }.getOrDefault(false)
        val url = Wifi.portalUrl()
        setContent {
            OrbitTheme {
                val st by Wifi.status.collectAsState()
                var loading by remember { mutableStateOf(true) }
                var done by remember { mutableStateOf(false) }
                LaunchedEffect(st.validated, st.captive) {
                    if (st.validated && !st.captive) { done = true; delay(1500); finish() }
                }
                LaunchedEffect(Unit) { delay(5 * 60_000L); finish() }
                Column(Modifier.fillMaxSize().background(C.bg)) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("📶 ${st.ssid ?: "Wi-Fi"}", color = C.text, fontSize = 17.sp)
                            Text(
                                when {
                                    done -> "Bağlandı ✓"
                                    loading -> "Onay sayfası açılıyor…"
                                    else -> "Sayfadaki onayı ver, internet gelince kendiliğinden kapanır."
                                },
                                color = if (done) C.good else C.muted, fontSize = 13.sp,
                            )
                        }
                        TextButton(onClick = { finish() }) { Text("Kapat") }
                    }
                    AndroidView(
                        factory = { ctx ->
                            WebView(ctx).apply {
                                settings.javaScriptEnabled = true
                                settings.domStorageEnabled = true
                                settings.setSupportMultipleWindows(false)
                                webViewClient = object : WebViewClient() {
                                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                                        val s = request.url.scheme?.lowercase()
                                        return s != "http" && s != "https"
                                    }
                                    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { loading = true }
                                    override fun onPageFinished(view: WebView, url: String?) { loading = false; Wifi.recheck() }
                                }
                                loadUrl(url)
                            }
                        },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
        }
    }

    override fun onDestroy() {
        if (bound) runCatching { getSystemService(ConnectivityManager::class.java).bindProcessToNetwork(null) }
        Wifi.recheck()
        super.onDestroy()
    }
}
