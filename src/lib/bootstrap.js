import crypto from "node:crypto";
import bcrypt from "bcryptjs";

// ---------------------------------------------------------------------------------
// Arranque seguro del administrador de plataforma.
//
// Antes, el sistema se "sembraba" con cuentas de demostración cuyas contraseñas estaban escritas en
// el código y en el README (soporte@diagnosticos.app / plataforma123, *.demo / demo123). Eso es un
// agujero: cualquiera que lea el repositorio puede entrar. Ahora:
//
//  - El administrador se crea (o se le cambia la contraseña) con las variables de entorno
//    ADMIN_EMAIL y ADMIN_PASSWORD. La contraseña NUNCA queda en el código ni se devuelve por HTTP.
//  - Si el sistema detecta cuentas que todavía usan una contraseña de demostración conocida, las
//    reporta (panel de admin + log) y, cuando ya hay un administrador configurado por entorno,
//    las deja inutilizables hasta que se les restablezca la contraseña desde el panel.
// ---------------------------------------------------------------------------------

export const KNOWN_WEAK_PASSWORDS = ["demo123", "plataforma123"];
export const MIN_ADMIN_PASSWORD = 12;
export const MIN_USER_PASSWORD = 8;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Cuentas cuya contraseña es una de las de demostración públicas. */
export async function findKnownPasswordAccounts(db) {
  const users = await db.user.findMany({});
  const hits = [];
  for (const u of users) {
    for (const pw of KNOWN_WEAK_PASSWORDS) {
      if (await bcrypt.compare(pw, u.passwordHash)) { hits.push(u); break; }
    }
  }
  return hits;
}

/**
 * Crea el administrador de plataforma o actualiza su contraseña según el entorno.
 * Devuelve { status: "skipped" | "invalid" | "created" | "updated" | "unchanged" | "refused", reason? }.
 */
export async function ensurePlatformAdmin({ db, email, password, name, log = console }) {
  if (!email && !password) return { status: "skipped", reason: "ADMIN_EMAIL y ADMIN_PASSWORD no están definidos." };
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) { log.error?.("[admin] ADMIN_EMAIL no es un correo válido."); return { status: "invalid", reason: "ADMIN_EMAIL no es un correo válido." }; }
  if (!password || String(password).length < MIN_ADMIN_PASSWORD) {
    log.error?.(`[admin] ADMIN_PASSWORD debe tener al menos ${MIN_ADMIN_PASSWORD} caracteres.`);
    return { status: "invalid", reason: `ADMIN_PASSWORD debe tener al menos ${MIN_ADMIN_PASSWORD} caracteres.` };
  }

  const existing = await db.user.findUnique({ where: { email: cleanEmail } });
  if (!existing) {
    await db.user.create({ data: { name: name || "Administrador de plataforma", email: cleanEmail, role: "platform_admin", passwordHash: await bcrypt.hash(password, 12) } });
    return { status: "created" };
  }
  // Nunca se "secuestra" una cuenta de un centro convirtiéndola en admin.
  if (existing.role !== "platform_admin") {
    log.error?.(`[admin] ${cleanEmail} ya existe como usuario de un centro; usa otro correo en ADMIN_EMAIL.`);
    return { status: "refused", reason: "Ese correo pertenece a un usuario de un centro." };
  }
  if (await bcrypt.compare(password, existing.passwordHash)) return { status: "unchanged" };
  await db.user.update({ where: { id: existing.id }, data: { passwordHash: await bcrypt.hash(password, 12) } });
  return { status: "updated" };
}

/** Deja inservible (contraseña aleatoria) cada cuenta con contraseña de demostración. El admin puede restablecerla desde el panel. */
export async function neutralizeKnownPasswordAccounts({ db, exceptIds = [] }) {
  const hits = (await findKnownPasswordAccounts(db)).filter((u) => !exceptIds.includes(u.id));
  for (const u of hits) {
    await db.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10) } });
  }
  return hits.map((u) => u.email);
}

/** Lo que corre al arrancar el servidor. Nunca lanza: un fallo aquí no debe impedir que el servicio levante. */
export async function runStartupSecurity({ db, env = process.env, log = console }) {
  try {
    const result = await ensurePlatformAdmin({ db, email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD, name: env.ADMIN_NAME, log });
    if (result.status === "created") log.log?.(`[admin] Administrador de plataforma creado: ${String(env.ADMIN_EMAIL).trim().toLowerCase()}`);
    if (result.status === "updated") log.log?.("[admin] Contraseña del administrador de plataforma actualizada desde ADMIN_PASSWORD.");

    const adminReady = ["created", "updated", "unchanged"].includes(result.status);
    if (adminReady) {
      const neutralized = await neutralizeKnownPasswordAccounts({ db });
      if (neutralized.length) log.warn?.(`[seguridad] Se inutilizaron ${neutralized.length} cuenta(s) con contraseña de demostración pública: ${neutralized.join(", ")}. Restablece su contraseña desde el panel de administrador.`);
    } else {
      const weak = await findKnownPasswordAccounts(db);
      if (weak.length) log.warn?.(`[seguridad] ¡${weak.length} cuenta(s) usan una contraseña de demostración PÚBLICA (${weak.map((u) => u.email).join(", ")})! Define ADMIN_EMAIL y ADMIN_PASSWORD en el servidor para corregirlo.`);
    }
    return { admin: result };
  } catch (err) {
    log.error?.(`[seguridad] No se pudo completar la verificación de arranque: ${err.message}`);
    return { error: err.message };
  }
}
