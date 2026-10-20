// Orbit — kanıt dosyası temizliği (15 dakikada bir, veritabanı zamanlayıcısı çağırır).
// Onaylanan/reddedilen görevlerin ve 7 günden eski tüm kanıtların dosyaları Storage'dan silinir.
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
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data: rows, error } = await admin
    .from("task_proofs")
    .select("id, path")
    .is("file_deleted_at", null)
    .or(`removed_at.not.is.null,created_at.lt.${weekAgo}`)
    .limit(500);
  if (error) return new Response(error.message, { status: 500 });
  if (!rows?.length) return Response.json({ deleted: 0 });
  const { error: delErr } = await admin.storage.from("orbit-proofs").remove(rows.map((r) => r.path));
  if (delErr) return new Response(delErr.message, { status: 500 });
  const now = new Date().toISOString();
  await admin
    .from("task_proofs")
    .update({ file_deleted_at: now, removed_at: now })
    .in("id", rows.map((r) => r.id));
  return Response.json({ deleted: rows.length });
});
