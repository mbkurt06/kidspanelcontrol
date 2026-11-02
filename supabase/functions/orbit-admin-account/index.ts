import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
  db: { schema: "orbit" },
});

function cors(req: Request) {
  const origin = req.headers.get("Origin") ?? "";
  const allowed = origin === "https://orbit-panel-nu.vercel.app" || /^http:\/\/localhost:\d+$/.test(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "https://orbit-panel-nu.vercel.app",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function fail(req: Request, message: string, status = 400) {
  return Response.json({ ok: false, error: message }, { status, headers: cors(req) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  try {
    const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return fail(req, "not_authenticated", 401);
    const { data: auth, error: authError } = await admin.auth.getUser(token);
    if (authError || !auth.user) return fail(req, "not_authenticated", 401);

    const { data: caller, error: callerError } = await admin
      .from("parents")
      .select("user_id, family_id")
      .eq("user_id", auth.user.id)
      .maybeSingle();
    if (callerError || !caller) return fail(req, "not_allowed", 403);

    const { data: approved } = await admin
      .from("parent_devices")
      .select("id")
      .eq("user_id", auth.user.id)
      .eq("family_id", caller.family_id)
      .eq("status", "approved")
      .limit(1)
      .maybeSingle();
    if (!approved) return fail(req, "not_allowed", 403);

    const body = await req.json();
    const userId = String(body.user_id ?? "");
    const email = String(body.email ?? "").trim().toLowerCase();
    const name = String(body.name ?? "").trim();
    const password = String(body.password ?? "");
    if (!userId || !email || !name) return fail(req, "missing_fields");
    if (!/^\S+@\S+\.\S+$/.test(email)) return fail(req, "invalid_email");
    if (password && password.length < 6) return fail(req, "password_too_short");

    const { data: target, error: targetError } = await admin
      .from("parents")
      .select("user_id, family_id, email")
      .eq("user_id", userId)
      .maybeSingle();
    if (targetError || !target || target.family_id !== caller.family_id) return fail(req, "not_allowed", 403);

    const authUpdate: { email?: string; email_confirm?: boolean; password?: string } = {};
    if (email !== target.email) {
      authUpdate.email = email;
      authUpdate.email_confirm = true;
    }
    if (password) authUpdate.password = password;
    if (Object.keys(authUpdate).length) {
      const { error } = await admin.auth.admin.updateUserById(userId, authUpdate);
      if (error) return fail(req, error.message);
    }

    const { error: parentError } = await admin.from("parents").update({ email, display_name: name }).eq("user_id", userId);
    if (parentError) return fail(req, parentError.message);

    if (email !== target.email) {
      await admin.from("allowed_parents").upsert({ email, family_id: caller.family_id, display_name: name });
      await admin.from("allowed_parents").delete().eq("email", target.email).eq("family_id", caller.family_id);
    } else {
      await admin.from("allowed_parents").update({ display_name: name }).eq("email", email).eq("family_id", caller.family_id);
    }

    return Response.json({ ok: true }, { headers: cors(req) });
  } catch (e) {
    console.error(e);
    return fail(req, "server_error", 500);
  }
});
