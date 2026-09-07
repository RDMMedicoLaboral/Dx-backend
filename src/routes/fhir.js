import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/audit.js";
import { serviceRequestToOrderInput, patientToFHIR, reportToDiagnosticReport } from "../lib/fhir.js";

const router = Router();

// El HCE se autentica con la clave que el superadmin configuró para ese centro
// (X-API-Key), no con un usuario/contraseña de Diagnostic OS.
async function requireTenantApiKey(req, res, next) {
  const { tenantId } = req.params;
  const apiKey = req.headers["x-api-key"];
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return res.status(404).json({ error: "Centro no encontrado." });
  if (!tenant.thirdPartyApiKey || tenant.thirdPartyApiKey !== apiKey) {
    return res.status(401).json({ error: "Clave de API inválida o no configurada para este centro." });
  }
  req.tenant = tenant;
  next();
}

// POST /api/fhir/tenants/:tenantId/ServiceRequest
// El HCE envía una orden (ServiceRequest FHIR) → creamos/emparejamos el paciente
// y creamos la orden internamente, más un IntegrationMessage de auditoría
// (spec sección 4: HCE → Diagnostic OS).
router.post("/tenants/:tenantId/ServiceRequest", requireTenantApiKey, async (req, res) => {
  const resource = req.body || {};
  if (resource.resourceType !== "ServiceRequest") {
    return res.status(400).json({ error: "Se esperaba un recurso FHIR de tipo ServiceRequest." });
  }
  const tenantId = req.tenant.id;
  const parsed = serviceRequestToOrderInput(resource);

  // Emparejamiento simple por documento si vino un Patient embebido; si no,
  // se crea un registro "pendiente" que el centro deberá confirmar.
  const patientResource = req.body.contained?.find((r) => r.resourceType === "Patient");
  let patient = null;
  if (patientResource) {
    const documentNumber = patientResource.identifier?.[0]?.value;
    patient = documentNumber ? await prisma.patient.findFirst({ where: { tenantId, documentNumber } }) : null;
    if (!patient) {
      patient = await prisma.patient.create({
        data: {
          tenantId,
          firstName: patientResource.name?.[0]?.given?.[0] || "Sin nombre",
          lastName: patientResource.name?.[0]?.family || "",
          documentNumber: documentNumber || parsed.externalPatientId || "SIN-DOC",
          birthDate: patientResource.birthDate || null,
          sex: patientResource.gender === "female" ? "F" : patientResource.gender === "male" ? "M" : null,
          sourceSystem: "HCE", sourcePatientId: patientResource.id || null, matchStatus: "pendiente",
        },
      });
    }
  }

  if (!patient) {
    return res.status(422).json({ error: "No se pudo determinar el paciente. Incluye un recurso Patient en 'contained'." });
  }

  const order = await prisma.order.create({
    data: {
      tenantId, patientId: patient.id, sourceSystem: parsed.sourceSystem, sourceType: "HCE",
      externalOrderId: parsed.externalOrderId, reason: parsed.reason, priority: parsed.priority,
      requestingPractitioner: parsed.requestingPractitioner,
    },
  });

  const message = await prisma.integrationMessage.create({
    data: { tenantId, type: "ServiceRequestReceived", direction: "inbound", source: req.tenant.thirdPartyName || "HCE", destination: "Diagnostic OS", status: "acknowledged", payloadSummary: `Orden ${order.id} creada desde ServiceRequest ${parsed.externalOrderId || ""}` },
  });

  await logAudit({ tenantId, action: "order.create.fhir", entityType: "Order", entityId: order.id, after: { source: "HCE" } });

  res.status(201).json({ resourceType: "OperationOutcome", issue: [{ severity: "information", code: "informational", diagnostics: `Orden creada: ${order.id}` }], _diagnosticOs: { orderId: order.id, patientId: patient.id, messageId: message.id } });
});

// GET /api/fhir/tenants/:tenantId/DiagnosticReport/:reportId
// El HCE puede consultar (pull) un informe ya publicado, en formato FHIR.
router.get("/tenants/:tenantId/DiagnosticReport/:reportId", requireTenantApiKey, async (req, res) => {
  const report = await prisma.diagnosticReport.findFirst({ where: { id: req.params.reportId, tenantId: req.tenant.id } });
  if (!report || report.status !== "published") return res.status(404).json({ error: "Informe no encontrado o no publicado." });
  const [order, study] = await Promise.all([
    prisma.order.findUnique({ where: { id: report.orderId } }),
    prisma.study.findUnique({ where: { id: report.studyId } }),
  ]);
  res.json(reportToDiagnosticReport(report, order, study));
});

// GET /api/fhir/tenants/:tenantId/Patient/:patientId
router.get("/tenants/:tenantId/Patient/:patientId", requireTenantApiKey, async (req, res) => {
  const patient = await prisma.patient.findFirst({ where: { id: req.params.patientId, tenantId: req.tenant.id } });
  if (!patient) return res.status(404).json({ error: "Paciente no encontrado." });
  res.json(patientToFHIR(patient));
});

export default router;
