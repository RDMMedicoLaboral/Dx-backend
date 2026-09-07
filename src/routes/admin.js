import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { authenticate, requirePlatformAdmin } from "../middleware/auth.js";
import { logAudit } from "../lib/audit.js";

const router = Router();
router.use(authenticate, requirePlatformAdmin);

function publicUser(u) {
  return { id: u.id, tenantId: u.tenantId, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt };
}

// --- Centros -----------------------------------------------------------------

router.get("/tenants", async (req, res) => {
  const tenants = await prisma.tenant.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { users: true } } } });
  res.json(tenants);
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

  res.status(201).json({ tenant, owner: publicUser(owner) });
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
    if (thirdPartyConnector.name) data.thirdPartyName = thirdPartyConnector.name;
    if (thirdPartyConnector.type) data.thirdPartyType = thirdPartyConnector.type;
    if (thirdPartyConnector.protocol) data.thirdPartyProtocol = thirdPartyConnector.protocol;
    if ("baseUrl" in thirdPartyConnector) data.thirdPartyBaseUrl = thirdPartyConnector.baseUrl || null;
    if ("apiKey" in thirdPartyConnector) data.thirdPartyApiKey = thirdPartyConnector.apiKey || null;
    if (thirdPartyConnector.status) data.thirdPartyStatus = thirdPartyConnector.status;
  }

  const tenant = await prisma.tenant.update({ where: { id }, data });
  await logAudit({ tenantId: id, userId: req.user.id, userName: req.user.name, action: "tenant.update", entityType: "Tenant", entityId: id, after: data });
  res.json(tenant);
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

export default router;

