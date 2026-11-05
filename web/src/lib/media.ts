import { supabase } from "./supabase";

/** OneDrive'daki kanıt: "<aile>/<koşu>/od:<öğe id>" */
export const isOneDrive = (path: string) => path.includes("/od:");

/**
 * Kanıt dosyalarının geçici adresleri (aynı sırayla). Supabase deposundakiler imzalı adres,
 * OneDrive'dakiler Microsoft'un 1 saatlik doğrudan indirme adresi (video oynatıcıda ileri sarılabilir).
 */
export async function mediaUrls(paths: string[], seconds = 3600): Promise<(string | undefined)[]> {
  return (await mediaLinks(paths, seconds)).map((x) => x.url);
}

/** Adres + küçük resim (OneDrive kare 300 px; depodakiler için küçük resim yok, tam boy kullanılır) */
export async function mediaLinks(paths: string[], seconds = 3600): Promise<{ url?: string; thumb?: string }[]> {
  const out = new Map<string, string | undefined>();
  const th = new Map<string, string | undefined>();
  const st = paths.filter((p) => !isOneDrive(p));
  const od = paths.filter(isOneDrive);
  await Promise.all([
    st.length
      ? supabase.storage.from("orbit-proofs").createSignedUrls(st, seconds).then(({ data }) => {
          st.forEach((p, i) => out.set(p, data?.[i]?.signedUrl ?? undefined));
        })
      : null,
    od.length
      ? supabase.functions.invoke("orbit-onedrive", { body: { action: "urls", paths: od } }).then(({ data }) => {
          const d = data as { urls?: Record<string, string | null>; thumbs?: Record<string, string | null> } | null;
          const urls = d?.urls ?? {};
          const thumbs = d?.thumbs ?? {};
          od.forEach((p) => { out.set(p, urls[p] ?? undefined); th.set(p, thumbs[p] ?? undefined); });
        })
      : null,
  ]);
  return paths.map((p) => ({ url: out.get(p), thumb: th.get(p) ?? out.get(p) }));
}

export type CloudStatus = { configured: boolean; connected: boolean; account: string | null; connected_at: string | null; client_id: string | null; retention_days: number };
