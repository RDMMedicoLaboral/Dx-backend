import crypto from "node:crypto";

// ---------------------------------------------------------------------------------
// Secretos de integración (claves de API, client_secret de OAuth2).
//
// - Se guardan CIFRADOS en la base (AES-256-GCM), nunca en texto plano.
// - La clave de cifrado sale de INTEGRATION_ENC_KEY; si no existe se deriva de
//   JWT_SECRET para que nada se rompa al actualizar. Lo ideal en producción es definir
//   INTEGRATION_ENC_KEY aparte: si algún día rotas JWT_SECRET, no pierdes los secretos.
// - Los valores guardados antes de este cambio (texto plano) siguen funcionando: si un
//   valor no empieza con "enc:v1:" se trata como legado y se devuelve tal cual.
// ---------------------------------------------------------------------------------

const PREFIX = "enc:v1:";

function getKey() {
  const raw = process.env.INTEGRATION_ENC_KEY || process.env.JWT_SECRET;
  if (!raw) throw new Error("Falta INTEGRATION_ENC_KEY (o JWT_SECRET) para cifrar los secretos de integración.");
  return crypto.createHash("sha256").update(`diagnostic-os:integration:${raw}`).digest(); // 32 bytes
}

export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptSecret(plain) {
  if (plain === null || plain === undefined || plain === "") return null;
  if (isEncrypted(plain)) return plain; // ya viene cifrado: no lo cifres dos veces
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(stored) {
  if (stored === null || stored === undefined || stored === "") return null;
  if (!isEncrypted(stored)) return stored; // valor legado en texto plano
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

/** Comparación en tiempo constante (evita adivinar la clave midiendo tiempos de respuesta). */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Clave aleatoria legible para entregar una sola vez (ej. dosk_3f9a...). */
export function generateApiKey() {
  return `dosk_${crypto.randomBytes(32).toString("hex")}`;
}
