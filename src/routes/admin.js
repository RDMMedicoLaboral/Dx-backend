import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { authenticate, requirePlatformAdmin } from "../middleware/auth.js";
import { logAudit } from "../lib/audit.js";
import { encryptSecret, generateApiKey, sha256Hex } from "../lib/secrets.js";
import { pushReportToConnector, retryIntegrationMessage, testConnector } from "../lib/integration.js";

const router = Router();
router.use(authenticate, requirePlatformAdmin);

function publicUser(u) {
  return { id: u.id, tenantId: u.tenantId, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt };
}

// Nunca devolvemos secretos al navegador: solo si existen o no.
function publicTenant(t) {
  if (!t) return t;
  const { thirdPartyApiKey, thirdPartyClientSecret, inboundKeyHash, ...rest } = t;
  return { ...rest, thirdPartyApiKeySet: Boolean(thirdPartyApiKey), thirdPartyClientSecretSet: Boolean(thirdPartyClientSecret), inboundKeySet: Boolean(inboundKeyHash) };
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
  const { name, kind, plan, hoursOpen, hoursClose, thirdPartyConnector } = req.body || {};
  const data = {};
  if (name) data.name = name.trim();
  if (kind) data.kind = kind;
  if (plan) data.plan = plan;
  if (hoursOpen) data.hoursOpen = hoursOpen;
  if (hoursClose) data.hoursClose = hoursClose;
  if (thirdPartyConnector) {
    try {
      if (thirdPartyConnector.disconnect) {
        // "Desconectar": borra TODA la configuración saliente y sus secretos. (La clave de entrada
        // del HCE se revoca aparte, generando una nueva.)
        Object.assign(data, {
          thirdPartyBaseUrl: null, thirdPartyApiKey: null, thirdPartyStatus: "No configurado", thirdPartyAuthType: "apikey",
          thirdPartyTokenUrl: null, thirdPartyClientId: null, thirdPartyClientSecret: null, thirdPartyScope: "system/DiagnosticReport.write",
        });
      } else {
        if (thirdPartyConnector.name) data.thirdPartyName = thirdPartyConnector.name;
        if (thirdPartyConnector.type) data.thirdPartyType = thirdPartyConnector.type;
        if (thirdPartyConnector.protocol) data.thirdPartyProtocol = thirdPartyConnector.protocol;
        if ("baseUrl" in thirdPartyConnector) data.thirdPartyBaseUrl = thirdPartyConnector.baseUrl ? checkUrl(thirdPartyConnector.baseUrl, "URL base") : null;
        if ("tokenUrl" in thirdPartyConnector) data.thirdPartyTokenUrl = thirdPartyConnector.tokenUrl ? checkUrl(thirdPartyConnector.tokenUrl, "URL del token") : null;
        if (thirdPartyConnector.authType) {
          if (!["apikey", "oauth2"].includes(thirdPartyConnector.authType)) return res.status(400).json({ error: "Tipo de autenticación no válido (apikey | oauth2)." });
          data.thirdPartyAuthType = thirdPartyConnector.authType;
        }
        if ("clientId" in thirdPartyConnector) data.thirdPartyClientId = thirdPartyConnector.clientId?.trim() || null;
        if (thirdPartyConnector.scope?.trim()) data.thirdPartyScope = thirdPartyConnector.scope.trim();
        // Si el panel manda client id + secret sin indicar el tipo, se entiende que es OAuth2.
        if (!thirdPartyConnector.authType && thirdPartyConnector.clientId && thirdPartyConnector.clientSecret) data.thirdPartyAuthType = "oauth2";
        applySecret(data, "thirdPartyApiKey", thirdPartyConnector.apiKey);
        applySecret(data, "thirdPartyClientSecret", thirdPartyConnector.clientSecret);
        if (thirdPartyConnector.status) data.thirdPartyStatus = thirdPartyConnector.status;
      }
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
  }

  const tenant = await prisma.tenant.update({ where: { id }, data });
  // En la auditoría NUNCA van los secretos, ni siquiera cifrados: solo qué campos cambiaron.
  const { thirdPartyApiKey, thirdPartyClientSecret, ...auditable } = data;
  await logAudit({ tenantId: id, userId: req.user.id, userName: req.user.name, action: "tenant.update", entityType: "Tenant", entityId: id, after: { ...auditable, ...(thirdPartyApiKey !== undefined ? { thirdPartyApiKey: "(actualizada)" } : {}), ...(thirdPartyClientSecret !== undefined ? { thirdPartyClientSecret: "(actualizado)" } : {}) } });
  res.json(publicTenant(tenant));
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

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

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

// Simulador de eventos de integración (ACK, error, duplicado, reintento,
// desconexión) — el mismo comportamiento que tenía la demo en el navegador,
// ahora registrado de verdad en la base de datos.
router.post("/tenants/:tenantId/integrations/simulate", async (req, res) => {
  const { tenantId } = req.params;
  const { kind } = req.body || {};
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return res.status(404).json({ error: "Centro no encontrado." });

  let message = null;
  if (kind === "ack") {
    const last = await prisma.integrationMessage.findFirst({ where: { tenantId, direction: "outbound", status: "sent" }, orderBy: { createdAt: "desc" } });
    if (last) message = await prisma.integrationMessage.update({ where: { id: last.id }, data: { status: "acknowledged" } });
  } else if (kind === "error") {
    message = await prisma.integrationMessage.create({ data: { tenantId, type: "IntegrationFailed", direction: "outbound", source: "Diagnostic OS", destination: "HCE-Ecosistema", status: "failed", payloadSummary: "Error simulado (HTTP 500)" } });
  } else if (kind === "duplicate") {
    message = await prisma.integrationMessage.create({ data: { tenantId, type: "ServiceRequestReceived", direction: "inbound", source: "HCE-Ecosistema", destination: "Diagnostic OS", status: "duplicate", payloadSummary: "Mensaje duplicado detectado (mismo eventId) — ignorado" } });
  } else if (kind === "retry") {
    const last = await prisma.integrationMessage.findFirst({ where: { tenantId, status: "failed" }, orderBy: { createdAt: "desc" } });
    if (last) message = await prisma.integrationMessage.update({ where: { id: last.id }, data: { status: "acknowledged", attempts: { increment: 1 } } });
  } else if (kind === "disconnect") {
    message = await prisma.integrationMessage.create({ data: { tenantId, type: "IntegrationFailed", direction: "outbound", source: "Diagnostic OS", destination: "HCE-Ecosistema", status: "failed", payloadSummary: "Sistema externo desconectado" } });
  }

  await logAudit({ tenantId, userId: req.user.id, userName: req.user.name, action: "integration.simulate", entityType: "IntegrationMessage", entityId: message?.id, after: { kind } });
  res.json({ ok: true, message });
});

// --- Conexión con el sistema externo (HCE / Clinic-OS) ---------------------------------

const tenantOr404 = async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.tenantId } });
  if (!tenant) res.status(404).json({ error: "Centro no encontrado." });
  return tenant;
};

// Comprueba token + servidor FHIR sin enviar ningún dato clínico.
router.post("/tenants/:tenantId/integrations/test", async (req, res) => {
  if (!(await tenantOr404(req, res))) return;
  const result = await testConnector(req.params.tenantId);
  await logAudit({ tenantId: req.params.tenantId, userId: req.user.id, userName: req.user.name, action: "integration.test", entityType: "Tenant", entityId: req.params.tenantId, after: { ok: result.ok } });
  res.json(result);
});

// Genera la clave que el HCE usará (X-API-Key) para ENVIAR órdenes a este centro. Se muestra una
// única vez: en la base solo queda su hash, así que si se pierde se genera otra (y la anterior deja de valer).
router.post("/tenants/:tenantId/integrations/inbound-key", async (req, res) => {
  const tenant = await tenantOr404(req, res);
  if (!tenant) return;
  const apiKey = generateApiKey();
  await prisma.tenant.update({ where: { id: tenant.id }, data: { inboundKeyHash: sha256Hex(apiKey) } });
  await logAudit({ tenantId: tenant.id, userId: req.user.id, userName: req.user.name, action: "integration.inbound-key.generate", entityType: "Tenant", entityId: tenant.id });
  const proto = req.get("x-forwarded-proto") || req.protocol;
  const base = `${proto}://${req.get("host")}/api/fhir/tenants/${tenant.id}`;
  res.json({ apiKey, tenantId: tenant.id, serviceRequestUrl: `${base}/ServiceRequest`, metadataUrl: `${base}/metadata`, header: "X-API-Key", note: "Cópiala ahora: no se vuelve a mostrar." });
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

