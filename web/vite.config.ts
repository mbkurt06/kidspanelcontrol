import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

// Panel sürümü: derleme zamanı (her yayında değişir) + kısa commit
function git(cmd: string): string {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}
const sha = (process.env.VERCEL_GIT_COMMIT_SHA || git("git rev-parse HEAD")).slice(0, 7);
const built = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Berlin" }).slice(0, 16);

export default defineConfig({
  plugins: [react()],
  define: {
    __PANEL_VERSION__: JSON.stringify(built),
    __PANEL_BUILD__: JSON.stringify(sha),
  },
});
