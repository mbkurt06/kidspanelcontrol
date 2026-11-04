import { supabase } from "./supabase";

/** OneDrive'daki kanıt: "<aile>/<koşu>/od:<öğe id>" */
export const isOneDrive = (path: string) => path.includes("/od:");

/**
 * Kanıt dosyalarının geçici adresleri (aynı sırayla). Supabase deposundakiler imzalı adres,
 * OneDrive'dakiler Microsoft'un 1 saatlik doğrudan indirme adresi (video oynatıcıda ileri sarılabilir).
 */
export async function mediaUrls(paths: string[], seconds = 3600): Promise<(string | undefined)[]> {
  const out = new Map<string, string | undefined>();
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
          const urls = (data as { urls?: Record<string, string | null> } | null)?.urls ?? {};
          od.forEach((p) => out.set(p, urls[p] ?? undefined));
        })
      : null,
  ]);
  return paths.map((p) => out.get(p));
}

export type CloudStatus = { configured: boolean; connected: boolean; account: string | null; connected_at: string | null; client_id: string | null; retention_days: number };
