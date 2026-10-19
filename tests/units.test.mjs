import { test } from "node:test";
import assert from "node:assert/strict";
process.env.JWT_SECRET = "test-secret";

const { encryptSecret, decryptSecret, safeEqual, sha256Hex, generateApiKey, isEncrypted } = await import("../src/lib/secrets.js");
const F = await import("../src/lib/fhir.js");

test("secretos: se cifran, se descifran y los valores legados en texto plano siguen funcionando", () => {
  const enc = encryptSecret("mi-clave");
  assert.ok(isEncrypted(enc));
  assert.notEqual(enc, "mi-clave");
  assert.equal(decryptSecret(enc), "mi-clave");
  assert.equal(decryptSecret("clave-vieja-sin-cifrar"), "clave-vieja-sin-cifrar");
  assert.equal(encryptSecret(enc), enc, "no se cifra dos veces");
  assert.equal(encryptSecret(""), null);
  assert.notEqual(encryptSecret("x"), encryptSecret("x"), "IV aleatorio");
});

test("secretos: un valor manipulado no descifra", () => {
  const enc = encryptSecret("abc");
  const tampered = enc.slice(0, -3) + (enc.endsWith("AAA") ? "BBB" : "AAA");
  assert.throws(() => decryptSecret(tampered));
});

test("secretos: comparación segura y claves generadas", () => {
  assert.ok(safeEqual("a", "a"));
  assert.ok(!safeEqual("a", "b"));
  assert.ok(!safeEqual("a", undefined));
  const k = generateApiKey();
  assert.match(k, /^dosk_[0-9a-f]{64}$/);
  assert.equal(sha256Hex(k).length, 64);
});

const patient = { id: "p1", firstName: "Ana", lastName: "Mora", documentType: "cedula", documentNumber: "0912345678", sex: "F", birthDate: "1990-05-01", externalIdentifiers: [{ system: "urn:clinicos:patient", value: "77", type: "HCE" }] };

test("paciente: la cédula va PRIMERO con el sistema urn:ec:cedula", () => {
  const p = F.patientToFHIR(patient);
  assert.deepEqual([p.identifier[0].system, p.identifier[0].value], ["urn:ec:cedula", "0912345678"]);
  assert.equal(p.identifier[1].system, "urn:diagnostic-os:patient");
  assert.equal(p.identifier[2].value, "77");
});

test("informe saliente: autocontenido, con cédula, Observations, orden original y adjuntos", () => {
  const report = { id: "r1", type: "LAB", status: "published", version: 1, conclusion: "Normal", authorName: "Lic. Loor", validatorName: "Dra. Andrade", publishedAt: new Date("2026-10-01T10:00:00Z"), patientId: "p1", amendmentReason: "" };
  const order = { id: "o1", externalOrderId: "LO-1001", sourceSystem: "urn:clinicos:lab-order" };
  const study = { id: "s1", serviceCode: "LAB-GLU", serviceName: "Glucosa en ayunas", externalStudyId: "LO-1001", completedAt: new Date("2026-10-01T09:00:00Z") };
  const results = [
    { id: "x1", analyte: "Glucosa", value: "0", unit: "mg/dL", referenceRange: "70-100", flag: "bajo", status: "validated" },
    { id: "x2", analyte: "Color", value: "amarillo", unit: "", flag: "normal", status: "validated" },
    { id: "x3", analyte: "Urea", value: "", unit: "mg/dL", flag: "normal", status: "validated" },
    { id: "x4", analyte: "Colesterol", value: "1,5", unit: "g/L", flag: "critico", status: "validated" },
  ];
  const attachments = [{ url: "https://res.cloudinary.com/x/informe.pdf", resourceType: "raw", format: "pdf", bytes: 1234, caption: "Informe firmado" }];
  const dr = F.reportToDiagnosticReport(report, order, study, { patient, results, attachments });

  assert.equal(dr.resourceType, "DiagnosticReport");
  assert.equal(dr.status, "final");
  assert.equal(dr.meta.versionId, "1");
  assert.deepEqual(dr.identifier, [{ system: "urn:diagnostic-os:report", value: "r1" }]);
  // paciente por cédula
  assert.equal(dr.subject.reference, "#patient");
  assert.equal(dr.subject.identifier.system, "urn:ec:cedula");
  assert.equal(dr.subject.identifier.value, "0912345678");
  assert.equal(dr.contained[0].resourceType, "Patient");
  assert.equal(dr.contained[0].identifier[0].value, "0912345678");
  // vínculo con la orden original (la que envió Clinic-OS), no con el id interno
  assert.equal(dr.basedOn[0].identifier.value, "LO-1001");
  assert.equal(dr.basedOn[0].identifier.system, "urn:clinicos:lab-order");
  // valores del examen
  const obs = dr.contained.filter((c) => c.resourceType === "Observation");
  assert.equal(obs.length, 4);
  assert.deepEqual(dr.result.map((r) => r.reference), ["#obs-1", "#obs-2", "#obs-3", "#obs-4"]);
  assert.equal(obs[0].valueQuantity.value, 0, "el valor 0 NO se pierde");
  assert.equal(obs[0].valueQuantity.unit, "mg/dL");
  assert.equal(obs[0].interpretation[0].coding[0].code, "L");
  assert.equal(obs[1].valueString, "amarillo");
  assert.ok(obs[2].dataAbsentReason, "sin valor => dataAbsentReason");
  assert.equal(obs[3].valueQuantity.value, 1.5, "coma decimal");
  assert.equal(obs[3].interpretation[0].coding[0].code, "AA");
  assert.ok(obs.every((o) => o.subject.reference === "#patient"));
  // adjuntos
  assert.deepEqual(dr.presentedForm[0], { contentType: "application/pdf", url: "https://res.cloudinary.com/x/informe.pdf", title: "Informe firmado", size: 1234 });
  assert.equal(dr.conclusion, "Normal");
  assert.equal(dr._diagnosticOs, undefined, "sin claves no-FHIR");
  // todo contenido tiene id local y es serializable
  assert.doesNotThrow(() => JSON.stringify(dr));
});

test("externalSystemOf: se devuelve el 'system' que envió la clínica; en órdenes antiguas, el sourceSystem si parece URN", () => {
  assert.equal(F.externalSystemOf({ externalSystem: "urn:rdm:orden", sourceSystem: "Clínica RDM" }), "urn:rdm:orden");
  assert.equal(F.externalSystemOf({ sourceSystem: "urn:clinicos:lab-order" }), "urn:clinicos:lab-order");
  assert.equal(F.externalSystemOf({ sourceSystem: "HCE" }), null);
  assert.equal(F.externalSystemOf({ sourceSystem: "Clínica RDM" }), null);
});

test("informe: una versión 2 publicada sale como 'amended'; sin orden externa usa el id interno", () => {
  const dr = F.reportToDiagnosticReport({ id: "r1", type: "LAB", status: "published", version: 2, amendmentReason: "Error de unidad" }, { id: "o9", externalOrderId: null }, { id: "s", serviceName: "X" }, {});
  assert.equal(dr.status, "amended");
  assert.equal(dr.basedOn[0].identifier.system, "urn:diagnostic-os:order");
  assert.equal(dr.basedOn[0].identifier.value, "o9");
  assert.ok(dr.extension.some((e) => e.valueString === "Error de unidad"));
});

test("informe de imágenes: impresión como conclusión y hallazgos como texto", () => {
  const dr = F.reportToDiagnosticReport({ id: "r2", type: "IMAGING", status: "published", version: 1, findings: "Sin <infiltrados>", impression: "Normal" }, null, { id: "s", serviceName: "Rx tórax", accessionNumber: "ACC1" }, { patient });
  assert.equal(dr.conclusion, "Normal");
  assert.match(dr.text.div, /Sin &lt;infiltrados&gt;/);
  assert.equal(dr.imagingStudy[0].identifier.value, "ACC1");
  assert.equal(dr.category[0].coding[0].code, "RAD");
});

test("entrada: la cédula se detecta aunque no sea el primer identificador", () => {
  const id = F.pickDocumentIdentifier({ identifier: [{ system: "urn:clinicos:patient", value: "77" }, { system: "urn:ec:cedula", value: " 0912345678 " }] });
  assert.equal(id.value, "0912345678");
  assert.equal(F.pickDocumentIdentifier({ identifier: [{ system: "x", value: "A1" }] }).value, "A1");
  assert.equal(F.pickDocumentIdentifier({ identifier: [] }), null);
});

test("entrada: ServiceRequest -> datos de orden", () => {
  const p = F.serviceRequestToOrderInput({ resourceType: "ServiceRequest", id: "sr-1", identifier: [{ system: "urn:clinicos:lab-order", value: "LO-1001" }], priority: "urgent", code: { coding: [{ system: "http://loinc.org", code: "1558-6", display: "Glucosa" }], text: "Glucosa en ayunas" }, subject: { reference: "#pat" }, requester: { display: "Dr. Pérez" }, reasonCode: [{ text: "Control" }], note: [{ text: "Paciente en ayunas" }] });
  assert.equal(p.externalOrderId, "LO-1001");
  assert.equal(p.sourceSystem, "urn:clinicos:lab-order");
  assert.equal(p.priority, "urgente");
  assert.equal(p.serviceName, "Glucosa en ayunas");
  assert.equal(p.requestingPractitioner.name, "Dr. Pérez");
});

const catalog = [
  { code: "LAB-HEMO", name: "Hemograma completo", modality: "LAB", externalCodes: ["LOINC:58410-2"], active: true },
  { code: "LAB-GLU", name: "Glucosa en ayunas", modality: "LAB", externalCodes: ["LOINC:1558-6"], active: true },
  { code: "RX-TORAX", name: "Radiografía de tórax PA", modality: "RX", externalCodes: [], active: false },
];
const parsed = (o) => ({ serviceName: "", serviceCodings: [], categoryCodes: [], ...o });

test("catálogo: empareja por código propio, por LOINC y por nombre (sin tildes); ignora inactivos", () => {
  assert.equal(F.matchCatalogItem(catalog, parsed({ serviceCodings: [{ system: "urn:diagnostic-os:service", code: "lab-glu", display: "" }] })).code, "LAB-GLU");
  assert.equal(F.matchCatalogItem(catalog, parsed({ serviceCodings: [{ system: "http://loinc.org", code: "58410-2", display: "" }] })).code, "LAB-HEMO");
  assert.equal(F.matchCatalogItem(catalog, parsed({ serviceName: "HEMOGRAMA  completo" })).code, "LAB-HEMO");
  assert.equal(F.matchCatalogItem(catalog, parsed({ serviceName: "Radiografia de torax PA" })), null, "inactivo");
  assert.equal(F.matchCatalogItem(catalog, parsed({ serviceName: "Algo raro" })), null);
});

test("modalidad: se adivina cuando el estudio no está en el catálogo", () => {
  assert.equal(F.guessModality(parsed({ serviceName: "Ecografía abdominal" }), "Centro mixto"), "ECO");
  assert.equal(F.guessModality(parsed({ serviceName: "Radiografía de mano" }), "Centro mixto"), "RX");
  assert.equal(F.guessModality(parsed({ serviceName: "Algo" }), "Laboratorio"), "LAB");
  assert.equal(F.guessModality(parsed({ serviceName: "Algo" }), "Centro de imágenes"), "RX");
});
