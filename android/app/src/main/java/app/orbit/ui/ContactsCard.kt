package app.orbit.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.Contacts

/** 📇 Kişiler kartı: başlığa basınca kapanır/açılır; satıra basınca bilgi büyük gösterilir. */
@Composable
fun ContactsCard() {
    LaunchedEffect(Unit) { Contacts.init() }
    val list by Contacts.list.collectAsState()
    if (list.isEmpty()) return
    var closed by remember { mutableStateOf(Contacts.collapsed) }
    var big by remember { mutableStateOf<Contacts.Contact?>(null) }
    Card {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { closed = !closed; Contacts.collapsed = closed }.padding(vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("📇 Kişiler", color = C.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(if (closed) "▾" else "▴", color = C.muted, fontSize = 20.sp)
        }
        if (!closed) for (c in list) {
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { big = c }.padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(c.emoji, fontSize = 20.sp, modifier = Modifier.width(34.dp))
                Text(c.name, color = C.text, fontSize = 15.sp, modifier = Modifier.width(90.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(c.value, color = C.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
    big?.let { c ->
        AlertDialog(
            onDismissRequest = { big = null },
            title = { Text("${c.emoji} ${c.name}") },
            text = {
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(c.value, color = C.text, fontSize = 30.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, lineHeight = 38.sp)
                }
            },
            confirmButton = { TextButton(onClick = { big = null }) { Text("Tamam") } },
        )
    }
}
