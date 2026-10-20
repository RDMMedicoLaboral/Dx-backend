import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/audit.js";
import {
  serviceRequestToOrderInput, patientToFHIR, reportToDiagnosticReport,
  pickDocumentIdentifier, matchCatalogItem, guessModality,
} from "../lib/fhir.js";
import { loadReportContext, identifiersVisibleTo } from "../lib/reportContext.js";
import { sha256Hex } from "../lib/secrets.js";
import { migrateLegacyConnections } from "../lib/connections.js";

const router = Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Respuesta de error en formato FHIR (OperationOutcome). Se mantiene también "error" en texto
// plano para no romper a quien ya lo leía.
function outcome(res, status, code, message) {
  // Deja rastro en el log del servidor de por qué se rechazó (sin datos del paciente): ayuda a la clínica a corregir su envío.
  if (status >= 400 && status < 500 && status !== 401) console.warn(`[fhir] ${status} ${message} (content-type: ${res.req?.headers?.["content-type"] || "ninguno"})`);
  return res.status(status).json({
    resourceType: "OperationOutcome",
    issue: [{ severity: "error", code, diagnostics: message }],
    error: message,
  });
}

// La clínica se autentica con la clave que el administrador generó PARA SU CONEXIÓN con este centro,
// enviada en X-API-Key (o como Bearer). La clave identifica a la clínica: de ahí sale req.connection,
// que marca cada orden que entra y limita todo lo que esa clínica puede consultar.
// En la base solo hay el hash SHA-256 de la clave (aleatoria de 256 bits, único en toda la tabla).
const requireConnectionKey = wrap(async (req, res, next) => {
  const { tenantId } = req.params;
  const bearer = (req.headers.authorization || "").startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
  const provided = String(req.headers["x-api-key"] || bearer || "");
  // Mismo mensaje exista o no el centro o la clave, para no revelar qué ids o claves son válidos.
  const reject = () => outcome(res, 401, "security", "Clave de API inválida o no configurada para este centro.");
  if (!provided) return reject();

  const hash = sha256Hex(provided);
  let connection = await prisma.connection.findFirst({ where: { inboundKeyHash: hash } });
  if (!connection) {
    // Centros configurados con la versión anterior (un solo conector): se migran en este momento y se reintenta.
    if (await migrateLegacyConnections(prisma, { tenantId })) connection = await prisma.connection.findFirst({ where: { inboundKeyHash: hash } });
  }
  // La clave de una clínica NO sirve en la URL de otro laboratorio.
  if (!connection || connection.tenantId !== tenantId) return reject();
  if (connection.enabled === false) return outcome(res, 403, "forbidden", "Esta conexión está desactivada por el laboratorio.");

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return reject();
  req.tenant = tenant;
  req.connection = connection;
  next();
});

// GET /api/fhir/tenants/:tenantId/metadata — sirve para comprobar que la conexión y la clave funcionan.
router.get("/tenants/:tenantId/metadata", requireConnectionKey, (req, res) => {
  res.json({
    resourceType: "CapabilityStatement", status: "active", kind: "instance", fhirVersion: "4.0.1", format: ["json"],
    publisher: req.tenant.name, // el laboratorio con el que se está conectando
    implementation: { description: `${req.tenant.name} · conexión "${req.connection.name}"` },
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

router.post("/tenants/:tenantId/ServiceRequest", requireConnectionKey, wrap(async (req, res) => {
  const tenant = req.tenant;
  const connection = req.connection; // la clínica que envía: sale de su clave, no de lo que diga el contenido
  const tenantId = tenant.id;
  const { requests, patientResource } = extractParts(req.body || {});

  if (!requests.length) {
    // Dice QUÉ llegó, para que quien envía vea de inmediato qué está mal en su mensaje.
    const body = req.body;
    const got = !body || typeof body !== "object" || !Object.keys(body).length
      ? `un cuerpo vacío o que no es JSON (content-type recibido: ${req.headers["content-type"] || "ninguno"})`
      : body.resourceType === "Bundle"
        ? `un Bundle sin ningún ServiceRequest dentro de "entry[].resource" (tipos recibidos: ${(body.entry || []).map((e) => e?.resource?.resourceType || "?").join(", ") || "ninguno"})`
        : `resourceType "${body.resourceType ?? "(no indicado)"}"${body.resource ? ' — el recurso parece venir envuelto dentro de un campo "resource"; debe enviarse directamente' : ""}`;
    return outcome(res, 400, "invalid", `Se esperaba un recurso FHIR ServiceRequest (o un Bundle con ServiceRequest). Se recibió ${got}.`);
  }
  if (!patientResource) return outcome(res, 422, "required", "No se pudo determinar el paciente. Incluye un recurso Patient en 'contained' (o en el Bundle).");
  const doc = pickDocumentIdentifier(patientResource);
  if (!doc) return outcome(res, 422, "required", "El Patient debe traer al menos un identifier con la cédula (el primero se toma como documento).");

  const parsedList = requests.map(serviceRequestToOrderInput);
  const first0 = parsedList[0];
  const externalOrderId = first0.requisitionId || first0.externalOrderId;
  const externalSystem = first0.externalSystem;
  const allCancelled = parsedList.every((p) => ["revoked", "entered-in-error"].includes(p.status));

  // --- Idempotencia: ¿esta CLÍNICA ya nos envió esta orden? ---------------------------
  // El número de orden solo es único DENTRO de una clínica: la orden "5" de la clínica A y la "5" de la
  // clínica B son órdenes distintas. Por eso siempre se busca por (laboratorio + conexión + número).
  const findDup = () => prisma.order.findFirst({ where: { tenantId, connectionId: connection.id, externalOrderId }, include: { studies: true } });
  const respondExisting = async (dup) => {
    // Si la clínica la anuló (status revoked / entered-in-error), reflejarlo en lugar de ignorarlo.
    if (allCancelled && dup.status !== "cancelled" && dup.status !== "completed") {
      await prisma.order.update({ where: { id: dup.id }, data: { status: "cancelled" } });
      await prisma.study.updateMany({ where: { orderId: dup.id, status: { in: ["scheduled", "arrived"] } }, data: { status: "cancelled" } });
      await prisma.integrationMessage.create({ data: { tenantId, connectionId: connection.id, type: "ServiceRequestCancelled", direction: "inbound", source: connection.name, destination: "Diagnostic OS", status: "acknowledged", payloadSummary: `Orden ${dup.id} anulada por ${connection.name} (${externalOrderId})` } });
      await logAudit({ tenantId, action: "order.cancel.fhir", entityType: "Order", entityId: dup.id, after: { source: connection.name, connectionId: connection.id } });
      return res.status(200).json({ resourceType: "OperationOutcome", issue: [{ severity: "information", code: "informational", diagnostics: `Orden anulada: ${dup.id}` }], _diagnosticOs: { orderId: dup.id, cancelled: true } });
    }
    await prisma.integrationMessage.create({ data: { tenantId, connectionId: connection.id, type: "ServiceRequestReceived", direction: "inbound", source: connection.name, destination: "Diagnostic OS", status: "duplicate", payloadSummary: `Orden ${externalOrderId} de ${connection.name} ya recibida (${dup.id}) — ignorada` } });
    return res.status(200).json({ resourceType: "OperationOutcome", issue: [{ severity: "information", code: "duplicate", diagnostics: `La orden ya existía: ${dup.id}` }], _diagnosticOs: { orderId: dup.id, patientId: dup.patientId, studyIds: dup.studies.map((s) => s.id), duplicate: true } });
  };

  if (externalOrderId) {
    const dup = await findDup();
    if (dup) return respondExisting(dup);
  }
  if (allCancelled) {
    return res.status(200).json({ resourceType: "OperationOutcome", issue: [{ severity: "information", code: "informational", diagnostics: "Orden anulada que Diagnostic OS nunca había recibido: nada que hacer." }] });
  }

  // --- Paciente: emparejar por documento (el paciente es del laboratorio); si no existe, crearlo "pendiente" ---
  // Los identificadores propios de cada clínica se guardan marcados con su conexión para no mezclarlos.
  const mine = (i) => ({ system: i.system || "", value: String(i.value), type: i.type?.text || "externo", connectionId: connection.id });
  const ownIds = [
    ...doc.all.filter((i) => i.value !== doc.value).map(mine),
    ...(patientResource.id ? [{ system: `urn:diagnostic-os:connection:${connection.id}`, value: String(patientResource.id), type: "externo", connectionId: connection.id }] : []),
  ];
  let patient = await prisma.patient.findFirst({ where: { tenantId, documentNumber: doc.value } });
  if (!patient) {
    patient = await prisma.patient.create({
      data: {
        tenantId,
        firstName: patientResource.name?.[0]?.given?.join(" ") || "Sin nombre",
        lastName: patientResource.name?.[0]?.family || "",
        documentType: /pasaporte|passport|ppn/i.test(`${doc.system} ${doc.all[0]?.type?.text || ""}`) ? "pasaporte" : "cedula",
        documentNumber: doc.value,
        birthDate: patientResource.birthDate || null,
        sex: patientResource.gender === "female" ? "F" : patientResource.gender === "male" ? "M" : null,
        externalIdentifiers: ownIds,
        sourceSystem: connection.name, sourcePatientId: patientResource.id || null, matchStatus: "pendiente",
      },
    });
  } else {
    const current = Array.isArray(patient.externalIdentifiers) ? patient.externalIdentifiers : [];
    const missing = ownIds.filter((n) => !current.some((c) => c.connectionId === n.connectionId && c.system === n.system && c.value === n.value));
    if (missing.length) patient = await prisma.patient.update({ where: { id: patient.id }, data: { externalIdentifiers: [...current, ...missing] } });
  }

  // --- Estudios: uno por ServiceRequest, tomados del catálogo del centro -----------------
  const catalog = await prisma.catalogItem.findMany({ where: { tenantId } });
  const studyRows = parsedList.map((p) => {
    const item = matchCatalogItem(catalog, p);
    return {
      tenantId, patientId: patient.id,
      serviceCode: item?.code || "EXT-SIN-CATALOGO",
      serviceName: item?.name || p.serviceName || `Estudio solicitado por ${connection.name}`,
      modality: item?.modality || guessModality(p, tenant.kind),
      externalStudyId: p.externalOrderId || null,
      _unmatched: !item,
    };
  });
  const unmatched = studyRows.filter((s) => s._unmatched).map((s) => s.serviceName);

  let order;
  try {
    order = await prisma.order.create({
      data: {
        tenantId, patientId: patient.id, connectionId: connection.id,
        sourceSystem: connection.name, externalSystem, sourceType: "HCE",
        externalOrderId, reason: first0.reason, priority: first0.priority,
        requestingPractitioner: first0.requestingPractitioner ?? undefined,
        encounterId: first0.encounterId, notes: [first0.notes, unmatched.length ? `⚠ Estudio(s) no encontrados en el catálogo, revisar: ${unmatched.join(", ")}` : ""].filter(Boolean).join(" — ") || null,
        scheduledAt: first0.scheduledAt ? new Date(first0.scheduledAt) : null,
        studies: { create: studyRows.map(({ _unmatched, ...s }) => s) },
      },
      include: { studies: true },
    });
  } catch (err) {
    // Dos envíos simultáneos de la misma orden: el índice único deja pasar solo uno; el otro responde "ya existía".
    if (err?.code === "P2002" && externalOrderId) { const dup = await findDup(); if (dup) return respondExisting(dup); }
    throw err;
  }

  const message = await prisma.integrationMessage.create({
    data: {
      tenantId, connectionId: connection.id, type: "ServiceRequestReceived", direction: "inbound", source: connection.name, destination: "Diagnostic OS", status: "acknowledged",
      payloadSummary: `Orden ${order.id} creada (${order.studies.length} estudio${order.studies.length === 1 ? "" : "s"}) desde ${connection.name} · ${externalOrderId || "ServiceRequest"}${unmatched.length ? ` — sin coincidencia de catálogo: ${unmatched.join(", ")}` : ""}`,
    },
  });
  await logAudit({ tenantId, action: "order.create.fhir", entityType: "Order", entityId: order.id, after: { source: connection.name, connectionId: connection.id, studies: order.studies.length, unmatchedCatalog: unmatched } });

  res.status(201).json({
    resourceType: "OperationOutcome",
    issue: [{ severity: "information", code: "informational", diagnostics: `Orden creada: ${order.id}` }, ...unmatched.map((n) => ({ severity: "warning", code: "not-found", diagnostics: `El estudio "${n}" no está en el catálogo del centro; se creó igualmente y el centro deberá clasificarlo.` }))],
    _diagnosticOs: { orderId: order.id, patientId: patient.id, studyIds: order.studies.map((s) => s.id), messageId: message.id },
  });
}));

// GET /api/fhir/tenants/:tenantId/DiagnosticReport/:reportId — consulta (pull) de un informe publicado.
// Una clínica SOLO puede leer informes de órdenes que ella misma envió.
router.get("/tenants/:tenantId/DiagnosticReport/:reportId", requireConnectionKey, wrap(async (req, res) => {
  const report = await prisma.diagnosticReport.findFirst({ where: { id: req.params.reportId, tenantId: req.tenant.id } });
  const order = report ? await prisma.order.findFirst({ where: { id: report.orderId, tenantId: req.tenant.id, connectionId: req.connection.id } }) : null;
  if (!report || !order || report.status !== "published") return outcome(res, 404, "not-found", "Informe no encontrado o no publicado.");
  const ctx = await loadReportContext(prisma, report);
  res.json(reportToDiagnosticReport(report, ctx.order, ctx.study, ctx));
}));

// GET /api/fhir/tenants/:tenantId/Patient/:patientId — solo pacientes que ESTA clínica ya ha enviado en alguna orden.
router.get("/tenants/:tenantId/Patient/:patientId", requireConnectionKey, wrap(async (req, res) => {
  const sent = await prisma.order.findFirst({ where: { tenantId: req.tenant.id, patientId: req.params.patientId, connectionId: req.connection.id } });
  const patient = sent ? await prisma.patient.findFirst({ where: { id: req.params.patientId, tenantId: req.tenant.id } }) : null;
  if (!patient) return outcome(res, 404, "not-found", "Paciente no encontrado.");
  res.json(patientToFHIR({ ...patient, externalIdentifiers: identifiersVisibleTo(patient.externalIdentifiers, req.connection.id) }));
}));

export default router;
