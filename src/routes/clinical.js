import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { authenticate, requireTenantUser } from "../middleware/auth.js";
import { requirePermission, PERMISSIONS } from "../lib/permissions.js";
import { logAudit } from "../lib/audit.js";
import { pushReportToConnector } from "../lib/integration.js";

const router = Router();
router.use(authenticate, requireTenantUser);

const tid = (req) => req.user.tenantId;

// --- Pacientes -----------------------------------------------------------------

router.get("/patients", async (req, res) => {
  res.json(await prisma.patient.findMany({ where: { tenantId: tid(req) }, orderBy: { createdAt: "desc" } }));
});

router.post("/patients", requirePermission(PERMISSIONS.CREATE_ORDER), async (req, res) => {
  const { firstName, lastName, documentType, documentNumber, birthDate, sex } = req.body || {};
  if (!firstName?.trim() || !lastName?.trim() || !documentNumber?.trim()) {
    return res.status(400).json({ error: "Nombre, apellido y documento son obligatorios." });
  }
  const patient = await prisma.patient.create({ data: { tenantId: tid(req), firstName: firstName.trim(), lastName: lastName.trim(), documentType: documentType || "cedula", documentNumber: documentNumber.trim(), birthDate, sex } });
  await logAudit({ tenantId: tid(req), userId: req.user.id, userName: req.user.name, action: "patient.create", entityType: "Patient", entityId: patient.id, after: patient });
  res.status(201).json(patient);
});

// --- Órdenes ---------------------------------------------------------------------

router.get("/orders", async (req, res) => {
  res.json(await prisma.order.findMany({ where: { tenantId: tid(req) }, orderBy: { createdAt: "desc" }, include: { studies: true } }));
});

router.post("/orders", requirePermission(PERMISSIONS.CREATE_ORDER), async (req, res) => {
  const { patientId, requestingPractitioner, reason, presumptiveDiagnosis, priority, notes, studies } = req.body || {};
  if (!patientId || !Array.isArray(studies) || studies.length === 0) {
    return res.status(400).json({ error: "Selecciona un paciente y al menos un estudio del catálogo." });
  }
  const patient = await prisma.patient.findFirst({ where: { id: patientId, tenantId: tid(req) } });
  if (!patient) return res.status(404).json({ error: "Paciente no encontrado en este centro." });

  const order = await prisma.order.create({
    data: {
      tenantId: tid(req), patientId, requestingPractitioner, reason, presumptiveDiagnosis, priority: priority || "rutina", notes,
      studies: { create: studies.map((s) => ({ tenantId: tid(req), patientId, serviceCode: s.code, serviceName: s.name, modality: s.modality })) },
    },
    include: { studies: true },
  });

  await logAudit({ tenantId: tid(req), userId: req.user.id, userName: req.user.name, action: "order.create", entityType: "Order", entityId: order.id, after: { patientId, studyCount: studies.length } });
  res.status(201).json(order);
});

router.patch("/orders/:id/status", requirePermission(PERMISSIONS.CREATE_ORDER), async (req, res) => {
  const { status } = req.body || {};
  const order = await prisma.order.updateMany({ where: { id: req.params.id, tenantId: tid(req) }, data: { status } });
  if (!order.count) return res.status(404).json({ error: "Orden no encontrada." });
  await logAudit({ tenantId: tid(req), userId: req.user.id, userName: req.user.name, action: "order.status", entityType: "Order", entityId: req.params.id, after: { status } });
  res.json({ ok: true });
});

// --- Estudios --------------------------------------------------------------------

router.get("/studies", async (req, res) => {
  res.json(await prisma.study.findMany({ where: { tenantId: tid(req) }, orderBy: { scheduledAt: "desc" } }));
});

router.patch("/studies/:id", async (req, res) => {
  const { status, room, equipment, technician, startedAt, completedAt, bodySite, laterality, technique } = req.body || {};
  const data = { status, room, equipment, technician, bodySite, laterality, technique };
  if (startedAt) data.startedAt = new Date(startedAt);
  if (completedAt) data.completedAt = new Date(completedAt);
  Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);

  const result = await prisma.study.updateMany({ where: { id: req.params.id, tenantId: tid(req) }, data });
  if (!result.count) return res.status(404).json({ error: "Estudio no encontrado." });
  await logAudit({ tenantId: tid(req), userId: req.user.id, userName: req.user.name, action: "study.update", entityType: "Study", entityId: req.params.id, after: data });
  res.json({ ok: true });
});

// --- Muestras (laboratorio) --------------------------------------------------------

router.get("/specimens", requirePermission(PERMISSIONS.MANAGE_SPECIMEN), async (req, res) => {
  res.json(await prisma.specimen.findMany({ where: { tenantId: tid(req) }, orderBy: { createdAt: "desc" } }));
});

router.post("/specimens", requirePermission(PERMISSIONS.MANAGE_SPECIMEN), async (req, res) => {
  const { studyId, type } = req.body || {};
  const specimen = await prisma.specimen.create({ data: { tenantId: tid(req), studyId, type } });
  res.status(201).json(specimen);
});

router.patch("/specimens/:id", requirePermission(PERMISSIONS.MANAGE_SPECIMEN), async (req, res) => {
  const { status, quality, rejectionReason, collectedAt, receivedAt } = req.body || {};
  const data = { status, quality, rejectionReason };
  if (collectedAt) data.collectedAt = new Date(collectedAt);
  if (receivedAt) data.receivedAt = new Date(receivedAt);
  Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
  const result = await prisma.specimen.updateMany({ where: { id: req.params.id, tenantId: tid(req) }, data });
  if (!result.count) return res.status(404).json({ error: "Muestra no encontrada." });
  res.json({ ok: true });
});

// --- Resultados (laboratorio) -------------------------------------------------------

router.get("/results", async (req, res) => {
  res.json(await prisma.result.findMany({ where: { tenantId: tid(req) } }));
});

router.post("/results", requirePermission(PERMISSIONS.ENTER_RESULT), async (req, res) => {
  const { studyId, specimenId, analyte, value, unit, referenceRange, method, flag } = req.body || {};
  const result = await prisma.result.create({ data: { tenantId: tid(req), studyId, specimenId, analyte, value, unit, referenceRange, method, flag: flag || "normal", status: "resulted" } });
  await logAudit({ tenantId: tid(req), userId: req.user.id, userName: req.user.name, action: "result.enter", entityType: "Result", entityId: result.id, after: { analyte, value } });
  res.status(201).json(result);
});

router.patch("/results/:id/validate", requirePermission(PERMISSIONS.VALIDATE_RESULT), async (req, res) => {
  const result = await prisma.result.updateMany({ where: { id: req.params.id, tenantId: tid(req) }, data: { status: "validated" } });
  if (!result.count) return res.status(404).json({ error: "Resultado no encontrado." });
  await logAudit({ tenantId: tid(req), userId: req.user.id, userName: req.user.name, action: "result.validate", entityType: "Result", entityId: req.params.id });
  res.json({ ok: true });
});

// --- Informes diagnósticos --------------------------------------------------------

router.get("/reports", async (req, res) => {
  res.json(await prisma.diagnosticReport.findMany({ where: { tenantId: tid(req) }, orderBy: { createdAt: "desc" } }));
});

router.post("/reports", requirePermission(PERMISSIONS.CREATE_REPORT), async (req, res) => {
  const { studyId, orderId, patientId, type, conclusion, findings, impression, resultIds } = req.body || {};
  const report = await prisma.diagnosticReport.create({
    data: { tenantId: tid(req), studyId, orderId, patientId, type, conclusion, findings, impression, resultIds: resultIds || [], authorId: req.user.id, authorName: req.user.name },
  });
  await logAudit({ tenantId: tid(req), userId: req.user.id, userName: req.user.name, action: "report.create", entityType: "DiagnosticReport", entityId: report.id });
  res.status(201).json(report);
});

router.patch("/reports/:id/validate", requirePermission(PERMISSIONS.VALIDATE_REPORT), async (req, res) => {
  const report = await prisma.diagnosticReport.updateMany({ where: { id: req.params.id, tenantId: tid(req) }, data: { status: "validated", validatorId: req.user.id, validatorName: req.user.name, validatedAt: new Date() } });
  if (!report.count) return res.status(404).json({ error: "Informe no encontrado." });
  await logAudit({ tenantId: tid(req), userId: req.user.id, userName: req.user.name, action: "report.validate", entityType: "DiagnosticReport", entityId: req.params.id });
  res.json({ ok: true });
});

// Publicar es el punto donde, si el centro tiene un conector externo configurado,
// se empuja el DiagnosticReport en formato FHIR hacia el HCE (spec sección 4).
router.patch("/reports/:id/publish", requirePermission(PERMISSIONS.PUBLISH_REPORT), async (req, res) => {
  const report = await prisma.diagnosticReport.findFirst({ where: { id: req.params.id, tenantId: tid(req) } });
  if (!report) return res.status(404).json({ error: "Informe no encontrado." });

  const updated = await prisma.diagnosticReport.update({ where: { id: report.id }, data: { status: "published", publishedAt: new Date() } });
  await logAudit({ tenantId: tid(req), userId: req.user.id, userName: req.user.name, action: "report.publish", entityType: "DiagnosticReport", entityId: report.id });

  pushReportToConnector(tid(req), updated).catch(() => {}); // mejor esfuerzo, no bloquea la respuesta

  res.json({ ok: true });
});

// --- Catálogo de estudios ----------------------------------------------------------

router.get("/catalog", async (req, res) => {
  res.json(await prisma.catalogItem.findMany({ where: { tenantId: tid(req) } }));
});

router.post("/catalog", requirePermission(PERMISSIONS.MANAGE_CATALOG), async (req, res) => {
  const { code, name, modality, price, preparation, estimatedTime } = req.body || {};
  const item = await prisma.catalogItem.create({ data: { tenantId: tid(req), code, name, modality, price: price || 0, preparation, estimatedTime } });
  res.status(201).json(item);
});

router.patch("/catalog/:id", requirePermission(PERMISSIONS.MANAGE_CATALOG), async (req, res) => {
  const result = await prisma.catalogItem.updateMany({ where: { id: req.params.id, tenantId: tid(req) }, data: req.body || {} });
  if (!result.count) return res.status(404).json({ error: "Servicio no encontrado." });
  res.json({ ok: true });
});

// --- Citas (agendadas desde la página pública de reservas) -------------------------

router.get("/appointments", async (req, res) => {
  res.json(await prisma.appointment.findMany({ where: { tenantId: tid(req) }, orderBy: { scheduledAt: "asc" } }));
});

// --- Mensajes de integración (solo lectura para el centro; configurarlos es cosa
// del superadmin en /api/admin) -------------------------------------------------

router.get("/integration-messages", requirePermission(PERMISSIONS.MANAGE_INTEGRATIONS), async (req, res) => {
  res.json(await prisma.integrationMessage.findMany({ where: { tenantId: tid(req) }, orderBy: { createdAt: "desc" } }));
});

// --- Auditoría -----------------------------------------------------------------

router.get("/audit", requirePermission(PERMISSIONS.VIEW_AUDIT), async (req, res) => {
  res.json(await prisma.auditEvent.findMany({ where: { tenantId: tid(req) }, orderBy: { timestamp: "desc" }, take: 200 }));
});

export default router;
