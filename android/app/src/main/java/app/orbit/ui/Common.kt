package app.orbit.ui

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.window.DialogProperties
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.drawable.toBitmap

object C {
    val bg = Color(0xFF0F1224)
    val surface = Color(0xFF171B33)
    val surface2 = Color(0xFF1F2442)
    val line = Color(0xFF2B3157)
    val text = Color(0xFFEEF0FF)
    val muted = Color(0xFF9AA0C3)
    val accent = Color(0xFF7C5CFF)
    val blue = Color(0xFF4F7CFF)
    val good = Color(0xFF2BB673)
    val warn = Color(0xFFF2B134)
    val bad = Color(0xFFFF5D6C)
}

@Composable
fun OrbitTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = C.accent, onPrimary = Color.White, background = C.bg, surface = C.surface, onSurface = C.text, onBackground = C.text,
            surfaceVariant = C.surface2, onSurfaceVariant = C.muted, outline = C.line,
        ),
        content = content,
    )
}

fun minutesText(min: Long): String = when {
    min < 60 -> "$min dk"
    min % 60 == 0L -> "${min / 60} sa"
    else -> "${min / 60} sa ${min % 60} dk"
}

@Composable
fun Card(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(C.surface)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) { content() }
}

@Composable
fun Ring(remaining: Float, color: Color, size: Dp, content: @Composable () -> Unit) {
    Box(Modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(size)) {
            val w = 14.dp.toPx()
            val inset = w / 2
            val arcSize = Size(this.size.width - w, this.size.height - w)
            drawArc(C.line, 0f, 360f, false, Offset(inset, inset), arcSize, style = Stroke(w))
            drawArc(color, -90f, 360f * remaining.coerceIn(0f, 1f), false, Offset(inset, inset), arcSize, style = Stroke(w, cap = StrokeCap.Round))
        }
        content()
    }
}

@Composable
fun AppIcon(pkg: String, size: Dp) {
    val ctx = LocalContext.current
    val bmp = remember(pkg) {
        runCatching { ctx.packageManager.getApplicationIcon(pkg).toBitmap(128, 128).asImageBitmap() }.getOrNull()
    }
    if (bmp != null) Image(bmp, null, Modifier.size(size).clip(RoundedCornerShape(12.dp)))
    else Box(Modifier.size(size).clip(RoundedCornerShape(12.dp)).background(C.surface2))
}

@Composable
fun AppTile(pkg: String, label: String, onClick: () -> Unit) {
    Column(
        Modifier.width(76.dp).clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick).padding(6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        AppIcon(pkg, 48.dp)
        Spacer(Modifier.height(6.dp))
        Text(label, color = C.text, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
    }
}

@Composable
fun Title(text: String) = Text(text, color = C.text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)

@Composable
fun Muted(text: String, size: Int = 14) = Text(text, color = C.muted, fontSize = size.sp)

@Composable
fun Info(text: String) {
    var open by remember { mutableStateOf(false) }
    Text("ⓘ", color = C.muted, fontSize = 16.sp, modifier = Modifier.clickable { open = true })
    if (open) AlertDialog(
        onDismissRequest = { open = false },
        properties = DialogProperties(dismissOnBackPress = true, dismissOnClickOutside = true),
        text = { Text(text, color = C.text, modifier = Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) },
        confirmButton = { TextButton(onClick = { open = false }) { Text("Tamam") } },
    )
}

fun launch(ctx: Context, pkg: String): Boolean {
    val i = ctx.packageManager.getLaunchIntentForPackage(pkg) ?: return false
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return runCatching { ctx.startActivity(i); true }.getOrDefault(false)
}

fun goHome(ctx: Context) {
    runCatching {
        ctx.startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
