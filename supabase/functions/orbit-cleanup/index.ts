// Orbit — kanıt dosyası temizliği (15 dakikada bir, veritabanı zamanlayıcısı çağırır).
// Silinmek üzere işaretlenen kanıtların dosyaları Storage'dan silinir.
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
  db: { schema: "orbit" },
});

Deno.serve(async (req) => {
  const { data: c } = await admin.rpc("server_config");
  if (req.headers.get("x-orbit-hook") !== (c as Record<string, string>)?.orbit_hook_secret) {
    return new Response("forbidden", { status: 403 });
  }
  // Silinecekleri işaretle: onaydan sonra saklama süresi dolanlar, kapanmış görevler, 45 günden eskiler.
  // Reddedilen görevlerin kanıtları karar verilene kadar saklanır (denemeler karşılaştırılabilsin).
  await admin.rpc("mark_proofs_for_cleanup");
  const { data: rows, error } = await admin
    .from("task_proofs")
    .select("id, path")
    .is("file_deleted_at", null)
    .not("removed_at", "is", null)
    .limit(500);
  if (error) return new Response(error.message, { status: 500 });
  if (!rows?.length) return Response.json({ deleted: 0 });
  // OneDrive'daki kanıtlar ("…/od:<id>") orbit-onedrive ile, diğerleri Storage'dan silinir
  const od = rows.filter((r) => r.path.includes("/od:"));
  const st = rows.filter((r) => !r.path.includes("/od:"));
  const doneIds: string[] = [];
  if (st.length) {
    const { error: delErr } = await admin.storage.from("orbit-proofs").remove(st.map((r) => r.path));
    if (delErr) return new Response(delErr.message, { status: 500 });
    doneIds.push(...st.map((r) => r.id));
  }
  if (od.length) {
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/orbit-onedrive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-orbit-hook": (c as Record<string, string>).orbit_hook_secret, Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}` },
      body: JSON.stringify({ action: "delete", paths: od.map((r) => r.path) }),
    });
    if (res.ok) {
      const { deleted } = await res.json();
      const set = new Set<string>(deleted ?? []);
      doneIds.push(...od.filter((r) => set.has(r.path)).map((r) => r.id));
    }
  }
  const now = new Date().toISOString();
  if (doneIds.length) await admin.from("task_proofs").update({ file_deleted_at: now, removed_at: now }).in("id", doneIds);
  return Response.json({ deleted: doneIds.length });
});
