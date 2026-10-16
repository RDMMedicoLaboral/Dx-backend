import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/audit.js";
import {
  serviceRequestToOrderInput, patientToFHIR, reportToDiagnosticReport,
  pickDocumentIdentifier, matchCatalogItem, guessModality,
} from "../lib/fhir.js";
import { loadReportContext } from "../lib/reportContext.js";
import { decryptSecret, sha256Hex, safeEqual } from "../lib/secrets.js";

const router = Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Respuesta de error en formato FHIR (OperationOutcome). Se mantiene también "error" en texto
// plano para no romper a quien ya lo leía.
function outcome(res, status, code, message) {
  return res.status(status).json({
    resourceType: "OperationOutcome",
    issue: [{ severity: "error", code, diagnostics: message }],
    error: message,
  });
}

// El sistema externo se autentica con la clave que el superadmin generó para ese centro,
// enviada en X-API-Key (o como Bearer). Se compara en tiempo constante.
//  - Preferido: inboundKeyHash (solo guardamos el hash SHA-256).
//  - Compatibilidad: centros antiguos que solo tienen thirdPartyApiKey.
const requireTenantApiKey = wrap(async (req, res, next) => {
  const { tenantId } = req.params;
  const bearer = (req.headers.authorization || "").startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
  const provided = String(req.headers["x-api-key"] || bearer || "");

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  // Mismo mensaje exista o no el centro, para no revelar qué ids son válidos.
  const reject = () => outcome(res, 401, "security", "Clave de API inválida o no configurada para este centro.");
  if (!tenant || !provided) return reject();

  let ok = false;
  if (tenant.inboundKeyHash) ok = safeEqual(sha256Hex(provided), tenant.inboundKeyHash);
  else {
    const legacy = decryptSecret(tenant.thirdPartyApiKey);
    ok = Boolean(legacy) && safeEqual(provided, legacy);
  }
  if (!ok) return reject();
  req.tenant = tenant;
  next();
});

// GET /api/fhir/tenants/:tenantId/metadata — sirve para comprobar que la conexión y la clave funcionan.
router.get("/tenants/:tenantId/metadata", requireTenantApiKey, (_req, res) => {
  res.json({
    resourceType: "CapabilityStatement", status: "active", kind: "instance", fhirVersion: "4.0.1", format: ["json"],
    software: { name: "Diagnostic OS" },
    rest: [{ mode: "server", resource: [
      { type: "ServiceRequest", interaction: [{ code: "create" }], updateCreate: false, conditionalCreate: false },
      { type: "DiagnosticReport", interaction: [{ code: "read" }] },
      { type: "Patient", interaction: [{ code: "read" }] },
    ] }],
  });
});

// ---------------------------------------------------------------------------------
// POST /api/fhir/tenants/:tenantId/ServiceRequest
// El HCE envía una orden de examen. Se acepta:
//   - un ServiceRequest (con el Patient en "contained"), o
//   - un Bundle (collection/transaction) con un Patient y uno o más ServiceRequest: cada
//     ServiceRequest será un estudio de UNA misma orden.
// Es idempotente: reenviar la misma orden (mismo identifier) no la duplica.
// ---------------------------------------------------------------------------------
function extractParts(body) {
  if (body?.resourceType === "ServiceRequest") {
    return { requests: [body], patientResource: (body.contained || []).find((r) => r.resourceType === "Patient") || null };
  }
  if (body?.resourceType === "Bundle") {
    const resources = (body.entry || []).map((e) => e.resource).filter(Boolean);
    const requests = resources.filter((r) => r.resourceType === "ServiceRequest");
    const patientResource = resources.find((r) => r.resourceType === "Patient") || requests.flatMap((r) => r.contained || []).find((r) => r.resourceType === "Patient") || null;
    return { requests, patientResource };
  }
  return { requests: [], patientResource: null };
}

router.post("/tenants/:tenantId/ServiceRequest", requireTenantApiKey, wrap(async (req, res) => {
  const tenant = req.tenant;
  const tenantId = tenant.id;
  const { requests, patientResource } = extractParts(req.body || {});

  if (!requests.length) return outcome(res, 400, "invalid", "Se esperaba un recurso FHIR ServiceRequest (o un Bundle con ServiceRequest).");
  if (!patientResource) return outcome(res, 422, "required", "No se pudo determinar el paciente. Incluye un recurso Patient en 'contained' (o en el Bundle).");
  const doc = pickDocumentIdentifier(patientResource);
  if (!doc) return outcome(res, 422, "required", "El Patient debe traer al menos un identifier con la cédula (el primero se toma como documento).");

  const parsedList = requests.map(serviceRequestToOrderInput);
  const first = parsedList[0];
  const externalOrderId = first.requisitionId || first.externalOrderId;
  const sourceSystem = first.sourceSystem;

  // --- Idempotencia: ¿ya recibimos esta orden? -------------------------------------
  if (externalOrderId) {
    const dup = await prisma.order.findFirst({ where: { tenantId, externalOrderId, sourceType: "HCE" }, include: { studies: true } });
    if (dup) {
      // Si el HCE la anuló (status revoked / entered-in-error), reflejarlo en lugar de ignorarlo.
      const cancelled = parsedList.every((p) => ["revoked", "entered-in-error"].includes(p.status));
      if (cancelled && dup.status !== "cancelled" && dup.status !== "completed") {
        await prisma.order.update({ where: { id: dup.id }, data: { status: "cancelled" } });
        await prisma.study.updateMany({ where: { orderId: dup.id, status: { in: ["scheduled", "arrived"] } }, data: { status: "cancelled" } });
        await prisma.integrationMessage.create({ data: { tenantId, type: "ServiceRequestCancelled", direction: "inbound", source: tenant.thirdPartyName || "HCE", destination: "Diagnostic OS", status: "acknowledged", payloadSummary: `Orden ${dup.id} anulada por el HCE (${externalOrderId})` } });
        await logAudit({ tenantId, action: "order.cancel.fhir", entityType: "Order", entityId: dup.id, after: { source: "HCE" } });
        return res.status(200).json({ resourceType: "OperationOutcome", issue: [{ severity: "information", code: "informational", diagnostics: `Orden anulada: ${dup.id}` }], _diagnosticOs: { orderId: dup.id, cancelled: true } });
      }
      await prisma.integrationMessage.create({ data: { tenantId, type: "ServiceRequestReceived", direction: "inbound", source: tenant.thirdPartyName || "HCE", destination: "Diagnostic OS", status: "duplicate", payloadSummary: `Orden ${externalOrderId} ya recibida (${dup.id}) — ignorada` } });
      return res.status(200).json({ resourceType: "OperationOutcome", issue: [{ severity: "information", code: "duplicate", diagnostics: `La orden ya existía: ${dup.id}` }], _diagnosticOs: { orderId: dup.id, patientId: dup.patientId, studyIds: dup.studies.map((s) => s.id), duplicate: true } });
    }
  }
  if (parsedList.every((p) => ["revoked", "entered-in-error"].includes(p.status))) {
    return res.status(200).json({ resourceType: "OperationOutcome", issue: [{ severity: "information", code: "informational", diagnostics: "Orden anulada que Diagnostic OS nunca había recibido: nada que hacer." }] });
  }

  // --- Paciente: emparejar por documento; si no existe, crearlo "pendiente" -----------
  let patient = await prisma.patient.findFirst({ where: { tenantId, documentNumber: doc.value } });
  if (!patient) {
    const others = doc.all.filter((i) => i.value !== doc.value).map((i) => ({ system: i.system || "", value: String(i.value), type: i.type?.text || "externo" }));
    patient = await prisma.patient.create({
      data: {
        tenantId,
        firstName: patientResource.name?.[0]?.given?.join(" ") || "Sin nombre",
        lastName: patientResource.name?.[0]?.family || "",
        documentType: /pasaporte|passport|ppn/i.test(`${doc.system} ${doc.all[0]?.type?.text || ""}`) ? "pasaporte" : "cedula",
        documentNumber: doc.value,
        birthDate: patientResource.birthDate || null,
        sex: patientResource.gender === "female" ? "F" : patientResource.gender === "male" ? "M" : null,
        externalIdentifiers: others,
        sourceSystem: tenant.thirdPartyName || "HCE", sourcePatientId: patientResource.id || null, matchStatus: "pendiente",
      },
    });
  } else if (!patient.sourcePatientId && patientResource.id) {
    patient = await prisma.patient.update({ where: { id: patient.id }, data: { sourceSystem: patient.sourceSystem || tenant.thirdPartyName || "HCE", sourcePatientId: patientResource.id } });
  }

  // --- Estudios: uno por ServiceRequest, tomados del catálogo del centro -----------------
  const catalog = await prisma.catalogItem.findMany({ where: { tenantId } });
  const studyRows = parsedList.map((p) => {
    const item = matchCatalogItem(catalog, p);
    return {
      tenantId, patientId: patient.id,
      serviceCode: item?.code || "EXT-SIN-CATALOGO",
      serviceName: item?.name || p.serviceName || "Estudio solicitado por el HCE",
      modality: item?.modality || guessModality(p, tenant.kind),
      externalStudyId: p.externalOrderId || null,
      _unmatched: !item,
    };
  });
  const unmatched = studyRows.filter((s) => s._unmatched).map((s) => s.serviceName);
  const first0 = parsedList[0];

  const order = await prisma.order.create({
    data: {
      tenantId, patientId: patient.id, sourceSystem, sourceType: "HCE",
      externalOrderId, reason: first0.reason, priority: first0.priority,
      requestingPractitioner: first0.requestingPractitioner ?? undefined,
      encounterId: first0.encounterId, notes: [first0.notes, unmatched.length ? `⚠ Estudio(s) no encontrados en el catálogo, revisar: ${unmatched.join(", ")}` : ""].filter(Boolean).join(" — ") || null,
      scheduledAt: first0.scheduledAt ? new Date(first0.scheduledAt) : null,
      studies: { create: studyRows.map(({ _unmatched, ...s }) => s) },
    },
    include: { studies: true },
  });

  const message = await prisma.integrationMessage.create({
    data: {
      tenantId, type: "ServiceRequestReceived", direction: "inbound", source: tenant.thirdPartyName || "HCE", destination: "Diagnostic OS", status: "acknowledged",
      payloadSummary: `Orden ${order.id} creada (${order.studies.length} estudio${order.studies.length === 1 ? "" : "s"}) desde ${externalOrderId || "ServiceRequest"}${unmatched.length ? ` — sin coincidencia de catálogo: ${unmatched.join(", ")}` : ""}`,
    },
  });
  await logAudit({ tenantId, action: "order.create.fhir", entityType: "Order", entityId: order.id, after: { source: "HCE", studies: order.studies.length, unmatchedCatalog: unmatched } });

  res.status(201).json({
    resourceType: "OperationOutcome",
    issue: [{ severity: "information", code: "informational", diagnostics: `Orden creada: ${order.id}` }, ...unmatched.map((n) => ({ severity: "warning", code: "not-found", diagnostics: `El estudio "${n}" no está en el catálogo del centro; se creó igualmente y el centro deberá clasificarlo.` }))],
    _diagnosticOs: { orderId: order.id, patientId: patient.id, studyIds: order.studies.map((s) => s.id), messageId: message.id },
  });
}));

// GET /api/fhir/tenants/:tenantId/DiagnosticReport/:reportId — consulta (pull) de un informe publicado.
router.get("/tenants/:tenantId/DiagnosticReport/:reportId", requireTenantApiKey, wrap(async (req, res) => {
  const report = await prisma.diagnosticReport.findFirst({ where: { id: req.params.reportId, tenantId: req.tenant.id } });
  if (!report || report.status !== "published") return outcome(res, 404, "not-found", "Informe no encontrado o no publicado.");
  const ctx = await loadReportContext(prisma, report);
  res.json(reportToDiagnosticReport(report, ctx.order, ctx.study, ctx));
}));

// GET /api/fhir/tenants/:tenantId/Patient/:patientId
router.get("/tenants/:tenantId/Patient/:patientId", requireTenantApiKey, wrap(async (req, res) => {
  const patient = await prisma.patient.findFirst({ where: { id: req.params.patientId, tenantId: req.tenant.id } });
  if (!patient) return outcome(res, 404, "not-found", "Paciente no encontrado.");
  res.json(patientToFHIR(patient));
}));

export default router;
