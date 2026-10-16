// ---------------------------------------------------------------------------------
// Mappers FHIR R4 del lado del servidor.
//
// Este archivo es la ÚNICA fuente de verdad del "contrato" FHIR de Diagnostic OS:
//  - Salida (Diagnostic OS -> HCE):   reportToDiagnosticReport(...)
//  - Entrada (HCE -> Diagnostic OS):  serviceRequestToOrderInput(...), pickDocumentIdentifier(...)
// El detalle del contrato (para quien construya el otro lado) está en
// docs/INTEGRACION_CLINIC-OS.md.
// ---------------------------------------------------------------------------------

export const SYSTEMS = {
  cedula: "urn:ec:cedula",
  dxPatient: "urn:diagnostic-os:patient",
  dxReport: "urn:diagnostic-os:report",
  dxOrder: "urn:diagnostic-os:order",
  clinicosLabOrder: "urn:clinicos:lab-order", // identificador de la orden en Clinic-Os
  dxService: "urn:diagnostic-os:service",
  dxResult: "urn:diagnostic-os:result",
  dxAccession: "urn:diagnostic-os:accession",
  loinc: "http://loinc.org",
  v2_0074: "http://terminology.hl7.org/CodeSystem/v2-0074",
  obsCategory: "http://terminology.hl7.org/CodeSystem/observation-category",
  interpretation: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
  extVersion: "urn:diagnostic-os:StructureDefinition/report-version",
  extAmendment: "urn:diagnostic-os:StructureDefinition/amendment-reason",
  extOrderId: "urn:diagnostic-os:StructureDefinition/order-id",
  extFindings: "urn:diagnostic-os:StructureDefinition/findings",
};

const isNumeric = (v) => /^-?\d+([.,]\d+)?$/.test(String(v ?? "").trim());
const toNumber = (v) => Number(String(v).trim().replace(",", "."));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const normText = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

// --- Paciente ---------------------------------------------------------------------

export function documentSystemFor(documentType) {
  const t = normText(documentType || "cedula");
  if (t === "cedula" || t === "cedula de identidad" || t === "ci") return SYSTEMS.cedula;
  return `urn:diagnostic-os:document:${t.replace(/\s+/g, "-")}`;
}

export function patientToFHIR(patient) {
  return {
    resourceType: "Patient",
    id: patient.id,
    identifier: [
      // El documento SIEMPRE va primero: es lo que usa el otro sistema para emparejar al paciente.
      { use: "official", system: documentSystemFor(patient.documentType), value: patient.documentNumber, type: { text: patient.documentType || "cedula" } },
      { system: SYSTEMS.dxPatient, value: patient.id },
      ...(Array.isArray(patient.externalIdentifiers) ? patient.externalIdentifiers : []).map((ei) => ({ system: ei.system, value: ei.value, ...(ei.type ? { type: { text: ei.type } } : {}) })),
    ],
    name: [{ family: patient.lastName, given: [patient.firstName] }],
    gender: patient.sex === "F" ? "female" : patient.sex === "M" ? "male" : "unknown",
    birthDate: patient.birthDate || undefined,
  };
}

/**
 * Elige el identificador que es el documento (cédula) de un recurso Patient entrante.
 * Prioridad: sistema que mencione "cedula" > type code NI/CI/PPN > primer identificador.
 */
export function pickDocumentIdentifier(patientResource) {
  const ids = Array.isArray(patientResource?.identifier) ? patientResource.identifier.filter((i) => i && i.value) : [];
  if (!ids.length) return null;
  const byCedula = ids.find((i) => /ced/i.test(i.system || "") || /ced/i.test(i.type?.text || ""));
  const byType = ids.find((i) => (i.type?.coding || []).some((c) => ["NI", "CI", "PPN", "DNI"].includes(c.code)));
  const chosen = byCedula || byType || ids[0];
  return { system: chosen.system || null, value: String(chosen.value).trim(), all: ids };
}

// --- Orden / estudio / resultados --------------------------------------------------

export function orderToServiceRequest(order, study) {
  return {
    resourceType: "ServiceRequest",
    id: order.id,
    identifier: order.externalOrderId ? [{ system: order.sourceSystem || "external", value: order.externalOrderId }] : undefined,
    status: order.status === "completed" ? "completed" : order.status === "cancelled" ? "revoked" : "active",
    intent: "order",
    priority: order.priority === "emergencia" ? "stat" : order.priority === "urgente" ? "urgent" : order.priority === "prioritaria" ? "asap" : "routine",
    code: study ? { text: study.serviceName } : undefined,
    subject: { reference: `Patient/${order.patientId}` },
    requester: order.requestingPractitioner ? { display: order.requestingPractitioner.name } : undefined,
    reasonCode: order.reason ? [{ text: order.reason }] : undefined,
    authoredOn: order.createdAt,
  };
}

const INTERPRETATION = { alto: ["H", "High"], bajo: ["L", "Low"], critico: ["AA", "Critical abnormal"], normal: ["N", "Normal"] };

export function observationFromResult(result, patientRef, localId) {
  const [iCode, iDisplay] = INTERPRETATION[result.flag] || INTERPRETATION.normal;
  const hasValue = String(result.value ?? "").trim() !== "";
  const obs = {
    resourceType: "Observation",
    id: localId || result.id,
    identifier: [{ system: SYSTEMS.dxResult, value: result.id }],
    status: result.status === "validated" ? "final" : result.status === "corrected" ? "amended" : result.status === "resulted" ? "preliminary" : "registered",
    category: [{ coding: [{ system: SYSTEMS.obsCategory, code: "laboratory", display: "Laboratory" }] }],
    code: { text: result.analyte },
    subject: typeof patientRef === "string" ? { reference: patientRef } : patientRef,
    interpretation: result.flag && result.flag !== "normal" ? [{ coding: [{ system: SYSTEMS.interpretation, code: iCode, display: iDisplay }], text: result.flag }] : undefined,
    referenceRange: result.referenceRange ? [{ text: result.referenceRange }] : undefined,
    method: result.method ? { text: result.method } : undefined,
  };
  if (!hasValue) obs.dataAbsentReason = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/data-absent-reason", code: "not-performed" }] };
  else if (isNumeric(result.value)) obs.valueQuantity = { value: toNumber(result.value), unit: result.unit || undefined };
  else obs.valueString = String(result.value) + (result.unit ? ` ${result.unit}` : "");
  return obs;
}

export function studyToImagingStudy(study, patientId) {
  return {
    resourceType: "ImagingStudy",
    id: study.id,
    identifier: study.accessionNumber ? [{ system: SYSTEMS.dxAccession, value: study.accessionNumber }] : undefined,
    status: study.status === "completed" ? "available" : study.status === "cancelled" ? "cancelled" : "registered",
    subject: { reference: `Patient/${patientId}` },
    started: study.startedAt || study.scheduledAt,
    modality: [{ system: "http://dicom.nema.org/resources/ontology/DCM", code: study.modality === "RX" ? "CR" : study.modality === "ECO" ? "US" : study.modality, display: study.serviceName }],
    procedureReference: study.studyInstanceUID ? { reference: `urn:dicom:uid:${study.studyInstanceUID}` } : undefined,
    note: study.bodySite ? [{ text: `Región: ${study.bodySite}${study.laterality && study.laterality !== "n/a" ? ` (${study.laterality})` : ""}` }] : undefined,
  };
}

// --- Informe (salida hacia el HCE) --------------------------------------------------

function attachmentContentType(a) {
  const f = String(a.format || "").toLowerCase();
  if (a.resourceType === "image") return `image/${f === "jpg" ? "jpeg" : f || "jpeg"}`;
  if (a.resourceType === "video") return `video/${f || "mp4"}`;
  if (f === "pdf") return "application/pdf";
  return "application/octet-stream";
}

/** A qué orden del sistema externo responde este informe (para que el otro lado lo vincule). */
export function basedOnFor(order, study) {
  const externalValue = study?.externalStudyId || order?.externalOrderId || null;
  if (externalValue) {
    return [{
      type: "ServiceRequest",
      reference: `ServiceRequest/${externalValue}`,
      identifier: { ...(order?.sourceSystem ? { system: order.sourceSystem } : {}), value: externalValue },
    }];
  }
  return order ? [{ type: "ServiceRequest", identifier: { system: SYSTEMS.dxOrder, value: order.id } }] : undefined;
}

/**
 * DiagnosticReport FHIR R4.
 * ctx (opcional) = { patient, results, attachments }. Si se entrega, el recurso sale
 * AUTOCONTENIDO: el paciente (cédula primero) y las Observations viajan dentro de
 * `contained`, y los archivos adjuntos en `presentedForm`. Así el sistema receptor no
 * necesita hacer consultas adicionales para entender el informe.
 */
export function reportToDiagnosticReport(report, order, study, ctx = {}) {
  const isLab = report.type === "LAB";
  const { patient, results = [], attachments = [] } = ctx;

  const patientRes = patient ? { ...patientToFHIR(patient), id: "patient" } : null;
  const subjectIdentifier = patientRes ? patientRes.identifier[0] : undefined;
  const patientName = patient ? `${patient.firstName} ${patient.lastName}`.trim() : undefined;

  const observations = isLab ? results.map((r, i) => observationFromResult(r, "#patient", `obs-${i + 1}`)) : [];
  const contained = [...(patientRes ? [patientRes] : []), ...observations];

  const extension = [
    { url: SYSTEMS.extVersion, valueInteger: report.version || 1 },
    ...(order ? [{ url: SYSTEMS.extOrderId, valueString: order.id }] : []),
    ...(report.amendmentReason ? [{ url: SYSTEMS.extAmendment, valueString: report.amendmentReason }] : []),
    ...(!isLab && report.findings ? [{ url: SYSTEMS.extFindings, valueString: report.findings }] : []),
  ];

  const presentedForm = attachments.map((a) => ({
    contentType: attachmentContentType(a),
    url: a.url,
    title: a.caption || `Adjunto ${a.format ? a.format.toUpperCase() : ""}`.trim(),
    size: a.bytes || undefined,
  }));

  return {
    resourceType: "DiagnosticReport",
    id: report.id,
    meta: { versionId: String(report.version || 1) },
    contained: contained.length ? contained : undefined,
    extension,
    identifier: [{ system: SYSTEMS.dxReport, value: report.id }],
    basedOn: basedOnFor(order, study),
    // Una versión 2+ publicada REEMPLAZA a una ya entregada: en FHIR eso es "amended", no "final".
    status: report.status === "published" ? ((report.version || 1) > 1 ? "amended" : "final") : report.status === "amended" ? "amended" : report.status === "validated" ? "preliminary" : "registered",
    category: [{ coding: [isLab ? { system: SYSTEMS.v2_0074, code: "LAB", display: "Laboratory" } : { system: SYSTEMS.v2_0074, code: "RAD", display: "Radiology" }] }],
    code: { ...(study?.serviceCode ? { coding: [{ system: SYSTEMS.dxService, code: study.serviceCode, display: study.serviceName }] } : {}), text: study?.serviceName },
    subject: patientRes
      ? { reference: "#patient", identifier: subjectIdentifier, display: patientName }
      : { reference: `Patient/${report.patientId}` },
    effectiveDateTime: study?.completedAt || study?.startedAt || undefined,
    issued: report.publishedAt || undefined,
    performer: report.authorName ? [{ display: report.authorName }] : undefined,
    resultsInterpreter: report.validatorName ? [{ display: report.validatorName }] : undefined,
    imagingStudy: !isLab && study?.accessionNumber ? [{ identifier: { system: SYSTEMS.dxAccession, value: study.accessionNumber } }] : undefined,
    result: isLab && observations.length ? observations.map((o) => ({ reference: `#${o.id}` })) : undefined,
    conclusion: (isLab ? report.conclusion : report.impression) || undefined,
    text: !isLab && report.findings ? { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${esc(report.findings)}</p></div>` } : undefined,
    presentedForm: presentedForm.length ? presentedForm : undefined,
  };
}

// --- Orden (entrada desde el HCE) ----------------------------------------------------

/** Interpreta un ServiceRequest FHIR entrante. */
export function serviceRequestToOrderInput(resource) {
  const subjectRef = resource.subject?.reference || "";
  const externalPatientId = subjectRef.includes("/") ? subjectRef.split("/").pop() : subjectRef.replace(/^#/, "");
  const ident = Array.isArray(resource.identifier) ? resource.identifier.find((i) => i?.value) : null;
  const codings = (resource.code?.coding || []).filter((c) => c && c.code);
  const requisition = resource.requisition?.value || null;
  return {
    status: resource.status || "active",
    externalOrderId: ident?.value || resource.id || null,
    requisitionId: requisition,
    sourceSystem: ident?.system || "HCE",
    reason: resource.reasonCode?.[0]?.text || resource.reasonCode?.[0]?.coding?.[0]?.display || "",
    priority: resource.priority === "stat" ? "emergencia" : resource.priority === "urgent" ? "urgente" : resource.priority === "asap" ? "prioritaria" : "rutina",
    requestingPractitioner: resource.requester?.display ? { name: resource.requester.display } : null,
    serviceName: resource.code?.text || codings.find((c) => c.display)?.display || "",
    serviceCodings: codings.map((c) => ({ system: c.system || "", code: String(c.code), display: c.display || "" })),
    categoryCodes: (resource.category || []).flatMap((c) => (c.coding || []).map((k) => String(k.code))),
    externalPatientId,
    notes: resource.note?.[0]?.text || "",
    encounterId: resource.encounter?.reference ? resource.encounter.reference.split("/").pop() : null,
    scheduledAt: resource.occurrenceDateTime || null,
  };
}

const SYSTEM_ALIAS = [[/loinc/i, "LOINC"], [/snomed/i, "SNOMED"], [/icd|cie/i, "CIE"], [/cpt/i, "CPT"]];
function aliasFor(system) {
  const hit = SYSTEM_ALIAS.find(([re]) => re.test(system || ""));
  return hit ? hit[1] : null;
}

/**
 * Busca en el catálogo del centro el estudio que pide el HCE. Orden de prioridad:
 *  1. coding.code igual al código del catálogo (lo más fiable: el HCE usa nuestros códigos)
 *  2. código externo (ej. LOINC:58410-2 en externalCodes)
 *  3. nombre del estudio (sin tildes ni mayúsculas)
 * Devuelve el item del catálogo o null.
 */
export function matchCatalogItem(catalog, parsed) {
  const items = (catalog || []).filter((c) => c.active !== false);
  for (const c of parsed.serviceCodings) {
    const hit = items.find((i) => i.code.toLowerCase() === c.code.toLowerCase());
    if (hit) return hit;
  }
  for (const c of parsed.serviceCodings) {
    const alias = aliasFor(c.system);
    const wanted = [c.code.toUpperCase(), ...(alias ? [`${alias}:${c.code}`.toUpperCase()] : [])];
    const hit = items.find((i) => (Array.isArray(i.externalCodes) ? i.externalCodes : []).some((e) => wanted.includes(String(e).toUpperCase())));
    if (hit) return hit;
  }
  const names = [parsed.serviceName, ...parsed.serviceCodings.map((c) => c.display)].filter(Boolean).map(normText);
  for (const n of names) {
    const hit = items.find((i) => normText(i.name) === n);
    if (hit) return hit;
  }
  return null;
}

/** Cuando el estudio no está en el catálogo, adivina la modalidad para poder crearlo igualmente. */
export function guessModality(parsed, tenantKind) {
  const text = normText(`${parsed.serviceName} ${parsed.serviceCodings.map((c) => c.display).join(" ")}`);
  if (/ecograf|ultrason|\beco\b/.test(text)) return "ECO";
  if (/radiograf|rayos|\brx\b|torax|tomograf|resonanc/.test(text)) return "RX";
  if (parsed.categoryCodes.includes("363679005") || parsed.categoryCodes.includes("RAD")) return "RX";
  if (parsed.categoryCodes.includes("108252007") || parsed.categoryCodes.includes("LAB")) return "LAB";
  if (/imagen/.test(normText(tenantKind))) return "RX";
  return "LAB";
}
