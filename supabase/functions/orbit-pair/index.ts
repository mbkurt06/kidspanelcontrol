// Orbit — cihaz eşleştirme.
// Çocuk telefonu veya Noor tableti, ebeveyn panelinde üretilen 8 haneli kodla eşleşir.
// Fonksiyon cihaz için ayrı bir Supabase Auth kullanıcısı açar ve giriş bilgilerini bir kez döndürür.
// Cihaz bu bilgileri Android Keystore'da saklar ve normal oturum açar; RLS her şeyi bu kullanıcıya göre sınırlar.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function randomSecret(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const code = String(body.code ?? "").replace(/\D/g, "");
  if (code.length !== 8) return json({ error: "bad_code" }, 400);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
    db: { schema: "orbit" },
  });

  // Kodu tek seferde "kullanıldı" olarak işaretle (yarış durumunda ikinci istek boş döner).
  const { data: claimed, error: claimErr } = await admin
    .from("pairing_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("code", code)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("code, family_id, child_id, kind")
    .maybeSingle();
  if (claimErr) return json({ error: "server_error", detail: claimErr.message }, 500);
  if (!claimed) return json({ error: "invalid_or_expired" }, 404);

  const deviceId = crypto.randomUUID();
  const email = `device-${deviceId}@orbit.invalid`;
  const password = randomSecret(32);

  const { data: created, error: userErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { orbit_device: deviceId, orbit_kind: claimed.kind },
  });
  if (userErr || !created.user) {
    return json({ error: "server_error", detail: userErr?.message }, 500);
  }

  const label = String(body.label ?? (claimed.kind === "viewer" ? "Noor tableti" : "Telefon")).slice(0, 60);
  const { error: devErr } = await admin.from("devices").insert({
    id: deviceId,
    family_id: claimed.family_id,
    child_id: claimed.child_id,
    kind: claimed.kind,
    auth_user_id: created.user.id,
    label,
    model: body.model ? String(body.model).slice(0, 80) : null,
    os_version: body.os_version ? String(body.os_version).slice(0, 40) : null,
    app_version: body.app_version ? String(body.app_version).slice(0, 20) : null,
    is_device_owner: typeof body.is_device_owner === "boolean" ? body.is_device_owner : null,
    last_seen_at: new Date().toISOString(),
  });
  if (devErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: "server_error", detail: devErr.message }, 500);
  }

  await admin.from("pairing_codes").update({ device_id: deviceId }).eq("code", code);
  await admin.from("events").insert({
    family_id: claimed.family_id,
    child_id: claimed.child_id,
    type: "device_paired",
    payload: { device_id: deviceId, label, model: body.model ?? null },
  });

  return json({
    device_id: deviceId,
    kind: claimed.kind,
    family_id: claimed.family_id,
    child_id: claimed.child_id,
    email,
    password,
  });
});
