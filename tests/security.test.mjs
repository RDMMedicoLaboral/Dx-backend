import { test, before, after } from "node:test";
import assert from "node:assert/strict";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";

await import("../src/lib/asyncErrors.js");
const bcrypt = (await import("bcryptjs")).default;
const express = (await import("express")).default;
const { prisma: db } = await import("./fakePrisma.mjs");
const { signToken } = await import("../src/middleware/auth.js");
const B = await import("../src/lib/bootstrap.js");
const { createRateLimiter } = await import("../src/lib/rateLimit.js");
const authRoutes = (await import("../src/routes/auth.js")).default;
const adminRoutes = (await import("../src/routes/admin.js")).default;

const quiet = { log() {}, warn() {}, error() {} };
const logs = () => { const l = { warn: [], error: [], log: [] }; return { l, log: { warn: (m) => l.warn.push(m), error: (m) => l.error.push(m), log: (m) => l.log.push(m) } }; };
const hash = (pw) => bcrypt.hash(pw, 4);
const resetUsers = () => { db.user._rows.length = 0; };

test("administrador: sin variables no hace nada; con datos inválidos avisa y no crea nada", async () => {
  resetUsers();
  assert.equal((await B.ensurePlatformAdmin({ db, log: quiet })).status, "skipped");
  assert.equal((await B.ensurePlatformAdmin({ db, email: "no-es-correo", password: "una-clave-bien-larga", log: quiet })).status, "invalid");
  assert.equal((await B.ensurePlatformAdmin({ db, email: "a@b.com", password: "corta", log: quiet })).status, "invalid");
  assert.equal(db.user._rows.length, 0);
});

test("administrador: se crea con hash (nunca en claro), es idempotente y la contraseña se puede rotar", async () => {
  resetUsers();
  const args = { db, email: " Admin@Empresa.COM ", password: "clave-larga-y-unica-1", log: quiet };
  assert.equal((await B.ensurePlatformAdmin(args)).status, "created");
  const row = db.user._rows[0];
  assert.equal(row.email, "admin@empresa.com");
  assert.equal(row.role, "platform_admin");
  assert.notEqual(row.passwordHash, "clave-larga-y-unica-1");
  assert.ok(await bcrypt.compare("clave-larga-y-unica-1", row.passwordHash));
  assert.equal((await B.ensurePlatformAdmin(args)).status, "unchanged");
  assert.equal((await B.ensurePlatformAdmin({ ...args, password: "otra-clave-larga-2" })).status, "updated");
  assert.ok(await bcrypt.compare("otra-clave-larga-2", db.user._rows[0].passwordHash));
  assert.equal(db.user._rows.length, 1);
});

test("administrador: NO convierte en admin la cuenta de un usuario de un centro", async () => {
  resetUsers();
  await db.user.create({ data: { tenantId: "t1", name: "Dueña", email: "duena@lab.com", role: "dueno", passwordHash: await hash("x-clave-larga-1") } });
  const r = await B.ensurePlatformAdmin({ db, email: "duena@lab.com", password: "una-clave-bien-larga", log: quiet });
  assert.equal(r.status, "refused");
  assert.equal(db.user._rows[0].role, "dueno");
});

test("detecta cuentas con contraseña de demostración pública", async () => {
  resetUsers();
  await db.user.create({ data: { name: "Soporte", email: "soporte@diagnosticos.app", role: "platform_admin", passwordHash: await hash("plataforma123") } });
  await db.user.create({ data: { tenantId: "t1", name: "Demo", email: "pandrade@sanrafael.demo", role: "dueno", passwordHash: await hash("demo123") } });
  await db.user.create({ data: { tenantId: "t1", name: "Real", email: "real@lab.com", role: "dueno", passwordHash: await hash("una-clave-segura-9") } });
  const weak = await B.findKnownPasswordAccounts(db);
  assert.deepEqual(weak.map((u) => u.email).sort(), ["pandrade@sanrafael.demo", "soporte@diagnosticos.app"]);
});

test("arranque SIN ADMIN_*: solo avisa, no toca nada (no te deja afuera por sorpresa)", async () => {
  const { l, log } = logs();
  const before = JSON.stringify(db.user._rows.map((u) => u.passwordHash));
  await B.runStartupSecurity({ db, env: {}, log });
  assert.equal(JSON.stringify(db.user._rows.map((u) => u.passwordHash)), before);
  assert.match(l.warn.join(" "), /soporte@diagnosticos\.app/);
  assert.match(l.warn.join(" "), /ADMIN_EMAIL/);
});

test("arranque CON ADMIN_*: crea el admin nuevo e inutiliza las contraseñas públicas (la real queda intacta)", async () => {
  const { l, log } = logs();
  await B.runStartupSecurity({ db, env: { ADMIN_EMAIL: "yo@empresa.com", ADMIN_PASSWORD: "mi-clave-muy-segura-77" }, log });
  const byEmail = (e) => db.user._rows.find((u) => u.email === e);
  assert.ok(byEmail("yo@empresa.com"));
  assert.ok(!(await bcrypt.compare("plataforma123", byEmail("soporte@diagnosticos.app").passwordHash)), "la contraseña pública ya no entra");
  assert.ok(!(await bcrypt.compare("demo123", byEmail("pandrade@sanrafael.demo").passwordHash)));
  assert.ok(await bcrypt.compare("una-clave-segura-9", byEmail("real@lab.com").passwordHash), "la cuenta con clave propia NO se toca");
  assert.match(l.warn.join(" "), /inutilizaron 2/);
  assert.equal((await B.findKnownPasswordAccounts(db)).length, 0);
});

test("el arranque nunca lanza aunque la base falle", async () => {
  const broken = { user: { findUnique: async () => { throw new Error("base caída"); }, findMany: async () => { throw new Error("base caída"); } } };
  const { l, log } = logs();
  const r = await B.runStartupSecurity({ db: broken, env: { ADMIN_EMAIL: "a@b.com", ADMIN_PASSWORD: "una-clave-bien-larga" }, log });
  assert.ok(r.error);
  assert.match(l.error.join(" "), /base caída/);
});

test("limitador: permite 8 intentos, bloquea el 9.º y se reinicia", () => {
  let t = 0; const rl = createRateLimiter({ max: 8, windowMs: 1000, now: () => t });
  for (let i = 0; i < 8; i++) assert.ok(rl.attempt("k").allowed);
  const blocked = rl.attempt("k");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
  assert.ok(rl.attempt("otro").allowed, "otra clave no se ve afectada");
  t = 1500; assert.ok(rl.attempt("k").allowed, "pasada la ventana vuelve a permitir");
  rl.reset("k"); assert.ok(rl.attempt("k").allowed);
});

// ---------------- rutas ----------------
let server, base, adminTok;
const call = async (method, path, { token, body, ip } = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(ip ? { "X-Forwarded-For": ip } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* vacío */ }
  return { status: res.status, body: json, headers: res.headers };
};

test("(preparación) servidor de pruebas con usuarios nuevos", async () => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/auth", authRoutes);
  app.use("/api/admin", adminRoutes);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
  resetUsers();
  await db.tenant.create({ data: { id: "t1", name: "Lab" } });
  await db.user.create({ data: { id: "u-admin", name: "Admin", email: "yo@empresa.com", role: "platform_admin", passwordHash: await hash("mi-clave-muy-segura-77") } });
  await db.user.create({ data: { id: "u-demo", tenantId: "t1", name: "Demo", email: "pandrade@sanrafael.demo", role: "dueno", passwordHash: await hash("demo123") } });
  await db.user.create({ data: { id: "u-ok", tenantId: "t1", name: "Real", email: "real@lab.com", role: "dueno", passwordHash: await hash("una-clave-segura-9") } });
  adminTok = signToken({ id: "u-admin", tenantId: null, role: "platform_admin", name: "Admin", email: "yo@empresa.com" });
});
after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });

test("login: tras 8 intentos fallidos responde 429 con Retry-After; un login correcto reinicia el contador", async () => {
  for (let i = 0; i < 8; i++) assert.equal((await call("POST", "/api/auth/admin-login", { body: { email: "yo@empresa.com", password: "mal" }, ip: "9.9.9.9" })).status, 401);
  const blocked = await call("POST", "/api/auth/admin-login", { body: { email: "yo@empresa.com", password: "mi-clave-muy-segura-77" }, ip: "9.9.9.9" });
  assert.equal(blocked.status, 429, "bloqueado aunque la clave sea correcta");
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  // otra IP no está bloqueada
  assert.equal((await call("POST", "/api/auth/admin-login", { body: { email: "yo@empresa.com", password: "mi-clave-muy-segura-77" }, ip: "8.8.8.8" })).status, 200);
  // el login de centro tiene su propio conteo por IP+correo
  for (let i = 0; i < 3; i++) await call("POST", "/api/auth/login", { body: { email: "real@lab.com", password: "mal" }, ip: "7.7.7.7" });
  assert.equal((await call("POST", "/api/auth/login", { body: { email: "real@lab.com", password: "una-clave-segura-9" }, ip: "7.7.7.7" })).status, 200);
});

test("admin: /security-check lista las cuentas con contraseña pública (y solo para platform_admin)", async () => {
  const r = await call("GET", "/api/admin/security-check", { token: adminTok });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.weakAccounts.map((a) => a.email), ["pandrade@sanrafael.demo"]);
  assert.ok(!JSON.stringify(r.body).includes("passwordHash"));
  const ownerTok = signToken({ id: "u-ok", tenantId: "t1", role: "dueno", name: "Real", email: "real@lab.com" });
  assert.equal((await call("GET", "/api/admin/security-check", { token: ownerTok })).status, 403);
  assert.equal((await call("GET", "/api/admin/security-check")).status, 401);
});

test("admin: restablecer la contraseña de la cuenta demo quita el aviso", async () => {
  const r = await call("PATCH", "/api/admin/users/u-demo", { token: adminTok, body: { password: "nueva-clave-segura-1" } });
  assert.equal(r.status, 200);
  assert.deepEqual((await call("GET", "/api/admin/security-check", { token: adminTok })).body.weakAccounts, []);
});

test("admin: exige contraseñas de al menos 8 caracteres y no permite tocar al administrador de plataforma", async () => {
  assert.equal((await call("PATCH", "/api/admin/users/u-ok", { token: adminTok, body: { password: "corta" } })).status, 400);
  assert.equal((await call("POST", "/api/admin/tenants/t1/users", { token: adminTok, body: { name: "X", email: "x@lab.com", password: "1234567", role: "laboratorista" } })).status, 400);
  assert.equal((await call("POST", "/api/admin/tenants", { token: adminTok, body: { centerName: "C", kind: "Laboratorio", ownerName: "O", email: "o@c.com", password: "123" } })).status, 400);
  const ok = await call("POST", "/api/admin/tenants/t1/users", { token: adminTok, body: { name: "X", email: "x@lab.com", password: "12345678", role: "laboratorista" } });
  assert.equal(ok.status, 201);
  const noAdmin = await call("PATCH", "/api/admin/users/u-admin", { token: adminTok, body: { password: "otra-clave-larga-12" } });
  assert.equal(noAdmin.status, 403);
  assert.match(noAdmin.body.error, /ADMIN_PASSWORD/);
});

test("el simulador de integraciones ya no existe en el servidor", async () => {
  const r = await call("POST", "/api/admin/tenants/t1/integrations/simulate", { token: adminTok, body: { kind: "ack" } });
  assert.equal(r.status, 404);
});
