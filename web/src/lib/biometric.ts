const CREDENTIAL_KEY = "orbit.face-id.credential.v1";
const ENABLED_KEY = "orbit.face-id.enabled.v1";

function bytes(size: number) {
  const out = new Uint8Array(size);
  crypto.getRandomValues(out);
  return out;
}

function b64(value: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64(value: string) {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function biometricEnabled() {
  return localStorage.getItem(ENABLED_KEY) === "1" && !!localStorage.getItem(CREDENTIAL_KEY);
}

export async function biometricSupported() {
  if (!("PublicKeyCredential" in window)) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** shortcut: doğrulama yerel cihaz kapısıdır; hesabın sunucu oturum güvenliği ayrıca devam eder. */
export async function registerBiometric(user: { id: string; email: string }) {
  if (!(await biometricSupported())) throw new Error("Bu cihazda Face ID/Touch ID desteklenmiyor.");
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: bytes(32),
      rp: { name: "Orbit", id: location.hostname },
      user: { id: new TextEncoder().encode(user.id), name: user.email, displayName: user.email },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
      timeout: 60_000,
    },
  });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("Face ID kaydı tamamlanamadı.");
  localStorage.setItem(CREDENTIAL_KEY, b64(credential.rawId));
  localStorage.setItem(ENABLED_KEY, "1");
}

export async function authenticateBiometric() {
  const id = localStorage.getItem(CREDENTIAL_KEY);
  if (!id) return false;
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: bytes(32),
      allowCredentials: [{ id: fromB64(id), type: "public-key", transports: ["internal"] }],
      userVerification: "required",
      timeout: 60_000,
    },
  });
  return credential instanceof PublicKeyCredential;
}

export function disableBiometric() {
  localStorage.removeItem(CREDENTIAL_KEY);
  localStorage.removeItem(ENABLED_KEY);
}
