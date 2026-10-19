import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { authenticate, requirePlatformAdmin } from "../middleware/auth.js";
import { logAudit } from "../lib/audit.js";
import { encryptSecret, generateApiKey, sha256Hex } from "../lib/secrets.js";
import { pushReportToConnector, retryIntegrationMessage, testConnector } from "../lib/integration.js";
import { findKnownPasswordAccounts, MIN_USER_PASSWORD } from "../lib/bootstrap.js";
import { connectionPublic } from "../lib/connections.js";

const router = Router();
router.use(authenticate, requirePlatformAdmin);

function publicUser(u) {
  return { id: u.id, tenantId: u.tenantId, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt };
}

// Nunca devolvemos secretos al navegador. (Los campos thirdParty* son de la versión anterior, ya migrados a
// "Connection"; se quitan de la respuesta.)
function publicTenant(t) {
  if (!t) return t;
  // eslint-disable-next-line no-unused-vars
  const { thirdPartyApiKey, thirdPartyClientSecret, inboundKeyHash, thirdPartyBaseUrl, thirdPartyClientId, thirdPartyTokenUrl, thirdPartyAuthType, thirdPartyScope, thirdPartyStatus, thirdPartyName, thirdPartyType, thirdPartyProtocol, ...rest } = t;
  return rest;
}

// Valida una URL de conector: http(s), sin usuario/clave incrustados, y https obligatorio en
// producción (salvo localhost, para poder probar en tu computadora).
function checkUrl(value, label) {
  let u;
  try { u = new URL(value); } catch { throw Object.assign(new Error(`${label}: la URL no es válida.`), { status: 400 }); }
  if (!["http:", "https:"].includes(u.protocol)) throw Object.assign(new Error(`${label}: debe empezar con https://`), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error(`${label}: no incluyas usuario ni clave dentro de la URL.`), { status: 400 });
  const local = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  if (process.env.NODE_ENV === "production" && u.protocol !== "https:" && !local) throw Object.assign(new Error(`${label}: en producción se exige https://`), { status: 400 });
  return value.trim().replace(/\/+$/, "");
}

// Para secretos: texto no vacío = guardar; null = borrar; vacío/ausente = dejar como está.
function applySecret(data, field, value) {
  if (typeof value === "string" && value.trim()) data[field] = encryptSecret(value.trim());
  else if (value === null) data[field] = null;
}

// --- Centros -----------------------------------------------------------------

router.get("/tenants", async (req, res) => {
  const tenants = await prisma.tenant.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { users: true } } } });
  res.json(tenants.map(publicTenant));
});

router.post("/tenants", async (req, res) => {
  const { centerName, kind, ownerName, email, password } = req.body || {};
  if (!centerName?.trim() || !kind || !ownerName?.trim() || !email?.trim() || !password?.trim()) {
    return res.status(400).json({ error: "Completa todos los campos para crear el centro y su dueño." });
  }
  if (password.trim().length < MIN_USER_PASSWORD) return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_USER_PASSWORD} caracteres.` });
  const cleanEmail = email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
  if (existing) return res.status(409).json({ error: "Ya existe una cuenta con ese correo." });

  const tenant = await prisma.tenant.create({ data: { name: centerName.trim(), kind } });
  const passwordHash = await bcrypt.hash(password, 10);
  const owner = await prisma.user.create({ data: { tenantId: tenant.id, name: ownerName.trim(), email: cleanEmail, role: "dueno", passwordHash } });

  await logAudit({ tenantId: tenant.id, userId: req.user.id, userName: req.user.name, action: "tenant.create", entityType: "Tenant", entityId: tenant.id, after: { name: tenant.name, owner: owner.email } });

  res.status(201).json({ tenant: publicTenant(tenant), owner: publicUser(owner) });
});

router.patch("/tenants/:id", async (req, res) => {
  const { id } = req.params;
  const { name, kind, plan, hoursOpen, hoursClose } = req.body || {};
  const data = {};
  if (name) data.name = name.trim();
  if (kind) data.kind = kind;
  if (plan) data.plan = plan;
  if (hoursOpen) data.hoursOpen = hoursOpen;
  if (hoursClose) data.hoursClose = hoursClose;
  const tenant = await prisma.tenant.update({ where: { id }, data });
  await logAudit({ tenantId: id, userId: req.user.id, userName: req.user.name, action: "tenant.update", entityType: "Tenant", entityId: id, after: data });
  res.json(publicTenant(tenant));
});

// --- Seguridad -----------------------------------------------------------------

// Cuentas que todavía usan una contraseña de demostración pública (para avisar en el panel).
router.get("/security-check", async (_req, res) => {
  const weak = await findKnownPasswordAccounts(prisma);
  res.json({ weakAccounts: weak.map((u) => ({ id: u.id, email: u.email, role: u.role, tenantId: u.tenantId })) });
});

// --- Usuarios ------------------------------------------------------------------

router.get("/users", async (req, res) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
  res.json(users.map(publicUser));
});

router.post("/tenants/:tenantId/users", async (req, res) => {
  const { tenantId } = req.params;
  const { name, email, password, role } = req.body || {};
  if (!name?.trim() || !email?.trim() || !password?.trim() || !role) {
    return res.status(400).json({ error: "Nombre, correo, contraseña y rol son obligatorios." });
  }
  if (role === "platform_admin") return res.status(400).json({ error: "No se puede crear un administrador de plataforma dentro de un centro." });
  if (password.trim().length < MIN_USER_PASSWORD) return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_USER_PASSWORD} caracteres.` });

  const cleanEmail = email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
  if (existing) return res.status(409).json({ error: "Ya existe una cuenta con ese correo." });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { tenantId, name: name.trim(), email: cleanEmail, role, passwordHash } });

  await logAudit({ tenantId, userId: req.user.id, userName: req.user.name, action: "user.create", entityType: "User", entityId: user.id, after: { email: user.email, role: user.role } });
  res.status(201).json(publicUser(user));
});

router.patch("/users/:id", async (req, res) => {
  const { id } = req.params;
  const { name, email, role, password } = req.body || {};
  if (role === "platform_admin") return res.status(400).json({ error: "No se puede asignar el rol de administrador de plataforma desde aquí." });

  if (password?.trim() && password.trim().length < MIN_USER_PASSWORD) return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_USER_PASSWORD} caracteres.` });

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
  // La cuenta de administrador de plataforma se gestiona SOLO con ADMIN_EMAIL / ADMIN_PASSWORD en el servidor.
  if (target.role === "platform_admin") return res.status(403).json({ error: "El administrador de plataforma se gestiona desde las variables de entorno del servidor (ADMIN_EMAIL / ADMIN_PASSWORD)." });

  const data = {};
  if (name?.trim()) data.name = name.trim();
  if (email?.trim()) {
    const cleanEmail = email.trim().toLowerCase();
    const clash = await prisma.user.findFirst({ where: { email: cleanEmail, NOT: { id } } });
    if (clash) return res.status(409).json({ error: "Ya existe otra cuenta con ese correo." });
    data.email = cleanEmail;
  }
  if (role) data.role = role;
  if (password?.trim()) data.passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.update({ where: { id }, data });
  await logAudit({ tenantId: target.tenantId, userId: req.user.id, userName: req.user.name, action: "user.update", entityType: "User", entityId: id, after: { ...data, passwordHash: data.passwordHash ? "(actualizada)" : undefined } });
  res.json(publicUser(user));
});

// --- Snapshot para el panel de integraciones (superadmin) --------------------------
// Le da a InteropView todo lo que necesita para armar sus vistas previas FHIR de
// un centro en particular, sin exponer estas rutas a los propios centros.

router.get("/tenants/:tenantId/snapshot", async (req, res) => {
  const { tenantId } = req.params;
  const [patients, orders, studies, diagnosticReports, integrationMessages] = await Promise.all([
    prisma.patient.findMany({ where: { tenantId } }),
    prisma.order.findMany({ where: { tenantId } }),
    prisma.study.findMany({ where: { tenantId } }),
    prisma.diagnosticReport.findMany({ where: { tenantId } }),
    prisma.integrationMessage.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } }),
  ]);
  res.json({ patients, orders, studies, diagnosticReports, integrationMessages });
});

// --- Conexiones del centro con clínicas / sistemas externos -------------------------------
// Un centro (laboratorio) puede tener VARIAS: una por cada clínica con la que trabaja. Cada una tiene su
// propia clave de entrada y su propio destino de retorno, y las órdenes quedan marcadas con la suya.

const tenantOr404 = async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.tenantId } });
  if (!tenant) res.status(404).json({ error: "Centro no encontrado." });
  return tenant;
};
const connectionOr404 = async (req, res) => {
  const c = await prisma.connection.findFirst({ where: { id: req.params.connectionId, tenantId: req.params.tenantId } });
  if (!c) res.status(404).json({ error: "Conexión no encontrada en este centro." });
  return c;
};
const originOf = (req) => `${req.get("x-forwarded-proto") || req.protocol}://${req.get("host")}`;

router.get("/tenants/:tenantId/connections", async (req, res) => {
  if (!(await tenantOr404(req, res))) return;
  const list = await prisma.connection.findMany({ where: { tenantId: req.params.tenantId }, orderBy: { createdAt: "asc" } });
  const out = [];
  for (const c of list) out.push(connectionPublic(c, { ordersCount: await prisma.order.count({ where: { connectionId: c.id } }) }));
  res.json(out);
});

router.post("/tenants/:tenantId/connections", async (req, res) => {
  if (!(await tenantOr404(req, res))) return;
  const { name, type } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "Escribe el nombre de la clínica o sistema que se va a conectar." });
  const clash = (await prisma.connection.findMany({ where: { tenantId: req.params.tenantId } })).find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (clash) return res.status(409).json({ error: "Ya hay una conexión con ese nombre en este centro." });
  const conn = await prisma.connection.create({ data: { tenantId: req.params.tenantId, name: name.trim(), type: type || "HCE" } });
  await logAudit({ tenantId: req.params.tenantId, userId: req.user.id, userName: req.user.name, action: "connection.create", entityType: "Connection", entityId: conn.id, after: { name: conn.name } });
  res.status(201).json(connectionPublic(conn, { ordersCount: 0 }));
});

router.patch("/tenants/:tenantId/connections/:connectionId", async (req, res) => {
  const conn = await connectionOr404(req, res);
  if (!conn) return;
  const b = req.body || {};
  const data = {};
  try {
    if (b.disconnect) {
      // "Quitar destino de retorno": borra la URL y TODAS las credenciales de salida. La clave de entrada se cambia aparte.
      Object.assign(data, { baseUrl: null, tokenUrl: null, clientId: null, clientSecret: null, apiKey: null, authType: "oauth2", scope: "system/DiagnosticReport.write" });
    } else {
      if (b.name?.trim()) {
        const clash = (await prisma.connection.findMany({ where: { tenantId: conn.tenantId } })).find((c) => c.id !== conn.id && c.name.trim().toLowerCase() === b.name.trim().toLowerCase());
        if (clash) return res.status(409).json({ error: "Ya hay otra conexión con ese nombre en este centro." });
        data.name = b.name.trim();
      }
      if (b.type) data.type = b.type;
      if (b.protocol) data.protocol = b.protocol;
      if (typeof b.enabled === "boolean") data.enabled = b.enabled;
      if ("baseUrl" in b) data.baseUrl = b.baseUrl ? checkUrl(b.baseUrl, "URL base") : null;
      if ("tokenUrl" in b) data.tokenUrl = b.tokenUrl ? checkUrl(b.tokenUrl, "URL del token") : null;
      if (b.authType) {
        if (!["apikey", "oauth2"].includes(b.authType)) return res.status(400).json({ error: "Tipo de autenticación no válido (apikey | oauth2)." });
        data.authType = b.authType;
      }
      if ("clientId" in b) data.clientId = b.clientId?.trim() || null;
      if (b.scope?.trim()) data.scope = b.scope.trim();
      // Si se mandan client id + secret sin indicar el tipo, se entiende que es OAuth2.
      if (!b.authType && b.clientId && b.clientSecret) data.authType = "oauth2";
      applySecret(data, "apiKey", b.apiKey);
      applySecret(data, "clientSecret", b.clientSecret);
    }
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const updated = await prisma.connection.update({ where: { id: conn.id }, data });
  // En la auditoría NUNCA van los secretos, ni siquiera cifrados: solo qué campos cambiaron.
  const { apiKey, clientSecret, ...auditable } = data;
  await logAudit({ tenantId: conn.tenantId, userId: req.user.id, userName: req.user.name, action: "connection.update", entityType: "Connection", entityId: conn.id, after: { ...auditable, ...(apiKey !== undefined ? { apiKey: "(actualizada)" } : {}), ...(clientSecret !== undefined ? { clientSecret: "(actualizado)" } : {}) } });
  res.json(connectionPublic(updated, { ordersCount: await prisma.order.count({ where: { connectionId: conn.id } }) }));
});

// Eliminar solo si nunca recibió órdenes. Si ya tiene historial, se DESACTIVA (enabled: false) para conservarlo.
router.delete("/tenants/:tenantId/connections/:connectionId", async (req, res) => {
  const conn = await connectionOr404(req, res);
  if (!conn) return;
  const n = await prisma.order.count({ where: { connectionId: conn.id } });
  if (n > 0) return res.status(409).json({ error: `Esta conexión tiene ${n} orden(es) en el historial. Desactívala en lugar de eliminarla.` });
  await prisma.connection.delete({ where: { id: conn.id } });
  await logAudit({ tenantId: conn.tenantId, userId: req.user.id, userName: req.user.name, action: "connection.delete", entityType: "Connection", entityId: conn.id, after: { name: conn.name } });
  res.json({ ok: true });
});

// Comprueba token + servidor FHIR de la clínica sin enviar ningún dato clínico.
router.post("/tenants/:tenantId/connections/:connectionId/test", async (req, res) => {
  const conn = await connectionOr404(req, res);
  if (!conn) return;
  const result = await testConnector(conn.tenantId, conn.id);
  await logAudit({ tenantId: conn.tenantId, userId: req.user.id, userName: req.user.name, action: "integration.test", entityType: "Connection", entityId: conn.id, after: { ok: result.ok } });
  res.json(result);
});

// Genera la clave que ESA clínica usará (X-API-Key) para enviar órdenes a este centro. Se muestra una sola vez:
// en la base solo queda su hash, así que si se pierde se genera otra (y la anterior deja de valer).
router.post("/tenants/:tenantId/connections/:connectionId/inbound-key", async (req, res) => {
  const conn = await connectionOr404(req, res);
  if (!conn) return;
  const tenant = await prisma.tenant.findUnique({ where: { id: conn.tenantId } });
  const apiKey = generateApiKey();
  await prisma.connection.update({ where: { id: conn.id }, data: { inboundKeyHash: sha256Hex(apiKey), inboundKeyCreatedAt: new Date() } });
  await logAudit({ tenantId: conn.tenantId, userId: req.user.id, userName: req.user.name, action: "integration.inbound-key.generate", entityType: "Connection", entityId: conn.id });
  const base = `${originOf(req)}/api/fhir/tenants/${conn.tenantId}`;
  res.json({
    apiKey, tenantId: conn.tenantId, tenantName: tenant?.name, connectionId: conn.id, connectionName: conn.name,
    fhirBaseUrl: base, serviceRequestUrl: `${base}/ServiceRequest`, metadataUrl: `${base}/metadata`, header: "X-API-Key",
    note: "Cópiala ahora: no se vuelve a mostrar.",
  });
});

// Reintento manual de un envío fallido (después de corregir la configuración, por ejemplo).
router.post("/tenants/:tenantId/integrations/messages/:messageId/retry", async (req, res) => {
  const msg = await prisma.integrationMessage.findFirst({ where: { id: req.params.messageId, tenantId: req.params.tenantId } });
  if (!msg) return res.status(404).json({ error: "Mensaje no encontrado en este centro." });
  const result = await retryIntegrationMessage(msg.id, { manual: true });
  await logAudit({ tenantId: req.params.tenantId, userId: req.user.id, userName: req.user.name, action: "integration.retry", entityType: "IntegrationMessage", entityId: msg.id, after: { status: result.message?.status } });
  if (!result.message) return res.status(409).json({ error: result.skipped });
  res.json({ ok: result.message.status !== "failed", message: result.message });
});

// Envía (o reenvía) un informe ya publicado — útil para los publicados ANTES de configurar el conector.
router.post("/tenants/:tenantId/integrations/reports/:reportId/send", async (req, res) => {
  if (!(await tenantOr404(req, res))) return;
  const result = await pushReportToConnector(req.params.tenantId, req.params.reportId, { force: true });
  if (!result.message) return res.status(409).json({ error: result.skipped || "No se pudo enviar." });
  await logAudit({ tenantId: req.params.tenantId, userId: req.user.id, userName: req.user.name, action: "integration.send-report", entityType: "DiagnosticReport", entityId: req.params.reportId, after: { status: result.message.status } });
  res.json({ ok: result.message.status !== "failed", message: result.message });
});

export default router;

