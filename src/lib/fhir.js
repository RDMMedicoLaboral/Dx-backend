// ---------------------------------------------------------------------------------
// Mismos mappers FHIR R4 que el frontend (src/lib/fhir.js), del lado del servidor,
// para que el adaptador de integración hable el mismo idioma que la UI que ya
// arma vistas previas de estos recursos.
// ---------------------------------------------------------------------------------

export function patientToFHIR(patient) {
  return {
    resourceType: "Patient",
    id: patient.id,
    identifier: [
      { system: "urn:diagnostic-os:document", value: patient.documentNumber },
      ...(patient.externalIdentifiers || []).map((ei) => ({ system: ei.system, value: ei.value, type: { text: ei.type } })),
    ],
    name: [{ family: patient.lastName, given: [patient.firstName] }],
    gender: patient.sex === "F" ? "female" : patient.sex === "M" ? "male" : "unknown",
    birthDate: patient.birthDate || undefined,
  };
}

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

export function observationFromResult(result, patientId) {
  return {
    resourceType: "Observation",
    id: result.id,
    status: result.status === "validated" ? "final" : result.status === "corrected" ? "amended" : "preliminary",
    code: { text: result.analyte },
    subject: { reference: `Patient/${patientId}` },
    valueQuantity: { value: Number(result.value) || result.value, unit: result.unit },
    referenceRange: result.referenceRange ? [{ text: result.referenceRange }] : undefined,
    interpretation: result.flag && result.flag !== "normal" ? [{ text: result.flag }] : undefined,
  };
}

export function studyToImagingStudy(study, patientId) {
  return {
    resourceType: "ImagingStudy",
    id: study.id,
    identifier: study.accessionNumber ? [{ system: "urn:diagnostic-os:accession", value: study.accessionNumber }] : undefined,
    status: study.status === "completed" ? "available" : study.status === "cancelled" ? "cancelled" : "registered",
    subject: { reference: `Patient/${patientId}` },
    started: study.startedAt || study.scheduledAt,
    modality: [{ system: "http://dicom.nema.org/resources/ontology/DCM", code: study.modality === "RX" ? "CR" : study.modality === "ECO" ? "US" : study.modality, display: study.serviceName }],
    procedureReference: study.studyInstanceUID ? { reference: `urn:dicom:uid:${study.studyInstanceUID}` } : undefined,
    note: study.bodySite ? [{ text: `Región: ${study.bodySite}${study.laterality && study.laterality !== "n/a" ? ` (${study.laterality})` : ""}` }] : undefined,
  };
}

export function reportToDiagnosticReport(report, order, study) {
  const isLab = report.type === "LAB";
  return {
    resourceType: "DiagnosticReport",
    id: report.id,
    status: report.status === "published" ? "final" : report.status === "amended" ? "amended" : report.status === "validated" ? "preliminary" : "registered",
    category: [{ coding: [isLab ? { system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: "LAB", display: "Laboratory" } : { system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: "RAD", display: "Radiology" }] }],
    code: { text: study?.serviceName },
    subject: { reference: `Patient/${report.patientId}` },
    basedOn: order ? [{ reference: `ServiceRequest/${order.id}` }] : undefined,
    imagingStudy: !isLab && study ? [{ reference: `ImagingStudy/${study.id}` }] : undefined,
    result: isLab ? (report.resultIds || []).map((id) => ({ reference: `Observation/${id}` })) : undefined,
    conclusion: isLab ? report.conclusion || undefined : report.impression || undefined,
    extension: !isLab ? [{ url: "findings", valueString: report.findings || undefined }] : undefined,
    author: report.authorName ? [{ display: report.authorName }] : undefined,
    _diagnosticOs: { version: report.version, amendmentReason: report.amendmentReason || undefined },
  };
}

/** Interpreta un ServiceRequest FHIR entrante (spec sección 4: HCE → Diagnostic OS). */
export function serviceRequestToOrderInput(resource) {
  const subjectRef = resource.subject?.reference || "";
  const externalPatientId = subjectRef.includes("/") ? subjectRef.split("/").pop() : subjectRef;
  return {
    externalOrderId: resource.identifier?.[0]?.value || resource.id || null,
    sourceSystem: resource.identifier?.[0]?.system || "HCE",
    reason: resource.reasonCode?.[0]?.text || "",
    priority: resource.priority === "stat" ? "emergencia" : resource.priority === "urgent" ? "urgente" : resource.priority === "asap" ? "prioritaria" : "rutina",
    requestingPractitioner: resource.requester?.display ? { name: resource.requester.display } : null,
    serviceName: resource.code?.text || "",
    externalPatientId,
  };
}
