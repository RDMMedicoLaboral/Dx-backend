import { Router } from "express";
import { prisma } from "../lib/prisma.js";

const router = Router();

// Lista de centros y su catálogo activo, para el selector de la página de reservas.
router.get("/tenants", async (_req, res) => {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true, kind: true, hoursOpen: true, hoursClose: true } });
  res.json(tenants.map((t) => ({ id: t.id, name: t.name, kind: t.kind, hours: { open: t.hoursOpen, close: t.hoursClose } })));
});

router.get("/tenants/:tenantId/catalog", async (req, res) => {
  const items = await prisma.catalogItem.findMany({ where: { tenantId: req.params.tenantId, active: true } });
  res.json(items);
});

router.post("/appointments", async (req, res) => {
  const { tenantId, patientName, documentNumber, serviceCode, scheduledAt } = req.body || {};
  if (!tenantId || !patientName?.trim() || !documentNumber?.trim() || !serviceCode || !scheduledAt) {
    return res.status(400).json({ error: "Completa todos los campos de la reserva." });
  }
  const service = await prisma.catalogItem.findFirst({ where: { tenantId, code: serviceCode, active: true } });
  if (!service) return res.status(404).json({ error: "El estudio seleccionado ya no está disponible." });

  const appointment = await prisma.appointment.create({
    data: { tenantId, patientName: patientName.trim(), documentNumber: documentNumber.trim(), serviceCode: service.code, serviceName: service.name, modality: service.modality, scheduledAt: new Date(scheduledAt), source: "Reserva en línea" },
  });
  res.status(201).json(appointment);
});

// --- Portal de resultados para pacientes -----------------------------------------
// Sin cuentas ni contraseñas: el paciente se identifica con su documento + fecha
// de nacimiento (algo que solo él sabe), igual que hacen muchos laboratorios
// reales en su "consulta de resultados en línea". Nunca se revela nada si esos
// dos datos no calzan con un paciente real.

async function findVerifiedPatient(tenantId, documentNumber, birthDate) {
  if (!tenantId || !documentNumber?.trim() || !birthDate) return null;
  return prisma.patient.findFirst({
    where: { tenantId, documentNumber: documentNumber.trim(), birthDate: birthDate },
  });
}

// GET /api/public/results/search?tenantId=&documentNumber=&birthDate=
router.get("/results/search", async (req, res) => {
  const { tenantId, documentNumber, birthDate } = req.query;
  const patient = await findVerifiedPatient(tenantId, documentNumber, birthDate);
  if (!patient) return res.status(404).json({ error: "No encontramos resultados con esos datos. Revisa el documento y la fecha de nacimiento." });

  const reports = await prisma.diagnosticReport.findMany({
    where: { tenantId, patientId: patient.id, status: "published" },
    orderBy: { publishedAt: "desc" },
  });
  const studyIds = reports.map((r) => r.studyId);
  const studies = await prisma.study.findMany({ where: { id: { in: studyIds } } });

  res.json({
    patientName: `${patient.firstName} ${patient.lastName}`,
    reports: reports.map((r) => ({
      id: r.id, type: r.type, publishedAt: r.publishedAt,
      studyName: studies.find((s) => s.id === r.studyId)?.serviceName || "Estudio",
    })),
  });
});

// GET /api/public/results/:reportId?tenantId=&documentNumber=&birthDate=
router.get("/results/:reportId", async (req, res) => {
  const { tenantId, documentNumber, birthDate } = req.query;
  const patient = await findVerifiedPatient(tenantId, documentNumber, birthDate);
  if (!patient) return res.status(404).json({ error: "No autorizado." });

  const report = await prisma.diagnosticReport.findFirst({ where: { id: req.params.reportId, tenantId, patientId: patient.id, status: "published" } });
  if (!report) return res.status(404).json({ error: "Informe no encontrado." });

  const [study, tenant, attachments] = await Promise.all([
    prisma.study.findUnique({ where: { id: report.studyId } }),
    prisma.tenant.findUnique({ where: { id: tenantId } }),
    prisma.attachment.findMany({ where: { tenantId, entityType: "DiagnosticReport", entityId: report.id } }),
  ]);

  res.json({
    tenantName: tenant?.name, patientName: `${patient.firstName} ${patient.lastName}`,
    studyName: study?.serviceName, modality: study?.modality, type: report.type,
    publishedAt: report.publishedAt, conclusion: report.conclusion, findings: report.findings, impression: report.impression,
    attachments: attachments.map((a) => ({ url: a.url, caption: a.caption, resourceType: a.resourceType })),
  });
});

export default router;
