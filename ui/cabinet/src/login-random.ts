/**
 * Вход Keycloak зовёт crypto.randomUUID.
 * На обычном http://IP браузер эту функцию прячет, хотя getRandomValues остаётся.
 * Без подмены на экране появляется «Web Crypto API is not available».
 */
export function ensureLoginRandom(): void {
  const webCrypto = globalThis.crypto;
  if (!webCrypto || typeof webCrypto.getRandomValues !== "function") return;
  if (randomUuidWorks(webCrypto)) return;

  const randomUUID = (): ReturnType<Crypto["randomUUID"]> =>
    formatUuid(webCrypto.getRandomValues(new Uint8Array(16))) as ReturnType<Crypto["randomUUID"]>;
  try {
    webCrypto.randomUUID = randomUUID;
  } catch {
    Object.defineProperty(webCrypto, "randomUUID", { configurable: true, value: randomUUID });
  }
}

export function formatUuid(bytes: Uint8Array): string {
  const copy = new Uint8Array(bytes);
  copy[6] = (copy[6] & 0x0f) | 0x40;
  copy[8] = (copy[8] & 0x3f) | 0x80;
  const hex = [...copy].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** На обычном http нет crypto.subtle. Keycloak по умолчанию всё равно включает PKCE, его надо выключить явно. */
export function choosePkceMethod(canHash: boolean): "S256" | false {
  return canHash ? "S256" : false;
}

function randomUuidWorks(webCrypto: Crypto): boolean {
  try {
    return typeof webCrypto.randomUUID === "function" && webCrypto.randomUUID().includes("-");
  } catch {
    return false;
  }
}
