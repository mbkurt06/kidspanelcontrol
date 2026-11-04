package app.orbit.ui

import android.content.ContentUris
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Size
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/** Telefondaki son ekran görüntüleri (Screenshots klasörü). */
object Screenshots {
    fun list(ctx: Context, limit: Int = 60): List<Uri> {
        val out = mutableListOf<Uri>()
        val col = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val sel = if (Build.VERSION.SDK_INT >= 29) "${MediaStore.Images.Media.RELATIVE_PATH} LIKE ?" else "${MediaStore.Images.Media.BUCKET_DISPLAY_NAME} LIKE ?"
        runCatching {
            ctx.contentResolver.query(col, arrayOf(MediaStore.Images.Media._ID), sel, arrayOf("%Screenshot%"), "${MediaStore.Images.Media.DATE_ADDED} DESC")?.use { c ->
                val idx = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
                while (c.moveToNext() && out.size < limit) out += ContentUris.withAppendedId(col, c.getLong(idx))
            }
        }
        return out
    }

    fun thumb(ctx: Context, uri: Uri): Bitmap? = runCatching {
        if (Build.VERSION.SDK_INT >= 29) ctx.contentResolver.loadThumbnail(uri, Size(320, 640), null)
        else ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = 4 }) }
    }.getOrNull()

    /** Yüklemek için JPEG'e çevir (uzun kenar en fazla 1600 px). */
    fun jpeg(ctx: Context, uri: Uri): ByteArray? = runCatching {
        val bmp = ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) } ?: return null
        val scale = (1600f / maxOf(bmp.width, bmp.height)).coerceAtMost(1f)
        val b = if (scale < 1f) Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true) else bmp
        ByteArrayOutputStream().also { b.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
    }.getOrNull()
}

@Composable
fun ScreenshotPicker(max: Int, onDismiss: () -> Unit, onPick: (List<Uri>) -> Unit) {
    val ctx = LocalContext.current
    var items by remember { mutableStateOf<List<Pair<Uri, Bitmap?>>?>(null) }
    var picked by remember { mutableStateOf<List<Uri>>(emptyList()) }
    LaunchedEffect(Unit) {
        app.orbit.device.Policy.grantSelf(ctx, if (Build.VERSION.SDK_INT >= 33) "android.permission.READ_MEDIA_IMAGES" else "android.permission.READ_EXTERNAL_STORAGE")
        items = withContext(Dispatchers.IO) { Screenshots.list(ctx).map { it to Screenshots.thumb(ctx, it) } }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = C.surface,
        title = { Text("Ekran görüntüsü seç", color = C.text) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Muted("Önce telefonda ekran görüntüsü al (güç + ses kısma), sonra burada seç. En fazla $max tane.", 13)
                val list = items
                when {
                    list == null -> Muted("Yükleniyor…")
                    list.isEmpty() -> Muted("Henüz ekran görüntüsü yok.")
                    else -> LazyVerticalGrid(GridCells.Fixed(3), Modifier.fillMaxWidth().height(420.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        items(list, key = { it.first.toString() }) { (uri, bmp) ->
                            val n = picked.indexOf(uri)
                            Box(
                                Modifier.aspectRatio(0.56f).clip(RoundedCornerShape(10.dp)).background(C.surface2)
                                    .border(if (n >= 0) 3.dp else 0.dp, C.accent, RoundedCornerShape(10.dp))
                                    .clickable {
                                        picked = if (n >= 0) picked - uri else if (picked.size < max) picked + uri else picked
                                    },
                            ) {
                                bmp?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxWidth().aspectRatio(0.56f), contentScale = ContentScale.Crop) }
                                if (n >= 0) Box(Modifier.align(Alignment.TopEnd).padding(6.dp).clip(CircleShape).background(C.accent).padding(horizontal = 8.dp, vertical = 2.dp)) {
                                    Text("${n + 1}", color = C.text, fontSize = 13.sp)
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { onPick(picked) }, enabled = picked.isNotEmpty()) { Text("Ekle (${picked.size})") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Vazgeç") } },
    )
}
