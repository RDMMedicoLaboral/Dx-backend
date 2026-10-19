import { test, before, after } from "node:test";
import assert from "node:assert/strict";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";

await import("../src/lib/asyncErrors.js");
const express = (await import("express")).default;
const { prisma: db } = await import("./fakePrisma.mjs");
const { startFakeClinicOs } = await import("./fakeClinicOs.mjs");
const { signToken } = await import("../src/middleware/auth.js");
const { isEncrypted, encryptSecret } = await import("../src/lib/secrets.js");

const adminRoutes = (await import("../src/routes/admin.js")).default;
const fhirRoutes = (await import("../src/routes/fhir.js")).default;
const stateRoutes = (await import("../src/routes/state.js")).default;
const clinicalRoutes = (await import("../src/routes/clinical.js")).default;

let server, base, clinic, adminTok, ownerTok, inboundKey, connId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(25); } throw new Error("timeout esperando condición"); }

const call = async (method, path, { token, body, headers } = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* vacío */ }
  return { status: res.status, body: json };
};

const patientRes = (extra = {}) => ({ resourceType: "Patient", id: "clinicos-pat-77", identifier: [{ system: "urn:clinicos:patient", value: "77" }, { system: "urn:ec:cedula", value: "0912345678" }], name: [{ family: "Mora", given: ["Ana"] }], gender: "female", birthDate: "1990-05-01", ...extra });
const serviceRequest = (id, over = {}) => ({ resourceType: "ServiceRequest", id, status: "active", intent: "order", identifier: [{ system: "urn:clinicos:lab-order", value: id }], priority: "routine", code: { coding: [{ system: "http://loinc.org", code: "1558-6", display: "Glucosa" }], text: "Glucosa en ayunas" }, subject: { reference: "#pat" }, requester: { display: "Dr. Pérez" }, contained: [patientRes()], ...over });

before(async () => {
  clinic = await startFakeClinicOs();
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/admin", adminRoutes);
  app.use("/api/fhir", fhirRoutes);
  app.use("/api/state", stateRoutes);
  app.use("/api", clinicalRoutes);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;

  await db.tenant.create({ data: { id: "t1", name: "Lab San Rafael", kind: "Laboratorio" } });
  await db.catalogItem.create({ data: { tenantId: "t1", code: "LAB-GLU", name: "Glucosa en ayunas", modality: "LAB", externalCodes: ["LOINC:1558-6"], active: true } });
  await db.user.create({ data: { id: "u-admin", tenantId: null, name: "Soporte", email: "a@x", passwordHash: "x", role: "platform_admin" } });
  await db.user.create({ data: { id: "u-owner", tenantId: "t1", name: "Dra. Andrade", email: "o@x", passwordHash: "x", role: "dueno" } });
  adminTok = signToken({ id: "u-admin", tenantId: null, role: "platform_admin", name: "Soporte", email: "a@x" });
  ownerTok = signToken({ id: "u-owner", tenantId: "t1", role: "dueno", name: "Dra. Andrade", email: "o@x" });
});
after(async () => { server?.closeAllConnections?.(); await new Promise((r) => server.close(r)); await clinic.close(); });

test("admin: crea la conexión con una clínica y configura su retorno (OAuth); secretos cifrados y NUNCA devueltos", async () => {
  const created = await call("POST", "/api/admin/tenants/t1/connections", { token: adminTok, body: { name: "Clínica RDM", type: "HCE" } });
  assert.equal(created.status, 201);
  connId = created.body.id;
  assert.equal(created.body.inboundKeySet, false);

  const r = await call("PATCH", `/api/admin/tenants/t1/connections/${connId}`, { token: adminTok, body: { baseUrl: clinic.baseUrl, authType: "oauth2", clientId: clinic.clientId, clientSecret: clinic.clientSecret, scope: "system/DiagnosticReport.write", apiKey: "otra-clave" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.clientSecret, undefined);
  assert.equal(r.body.apiKey, undefined);
  assert.equal(r.body.clientSecretSet, true);
  assert.equal(r.body.authType, "oauth2");
  const row = db.connection._rows.find((c) => c.id === connId);
  assert.ok(isEncrypted(row.clientSecret) && isEncrypted(row.apiKey));
  assert.ok(!JSON.stringify(await db.auditEvent.findMany({})).includes(clinic.clientSecret), "el secreto no queda en la auditoría");

  const list = await call("GET", "/api/admin/tenants/t1/connections", { token: adminTok });
  assert.ok(!JSON.stringify(list.body).includes(clinic.clientSecret));
  assert.equal(list.body[0].clientSecretSet, true);

  // guardar de nuevo sin tocar el secreto (el panel manda vacío) NO lo borra
  await call("PATCH", `/api/admin/tenants/t1/connections/${connId}`, { token: adminTok, body: { clientSecret: "" } });
  assert.ok(db.connection._rows.find((c) => c.id === connId).clientSecret);
});

test("admin: nombre obligatorio y sin repetir dentro del mismo centro", async () => {
  assert.equal((await call("POST", "/api/admin/tenants/t1/connections", { token: adminTok, body: { name: " " } })).status, 400);
  assert.equal((await call("POST", "/api/admin/tenants/t1/connections", { token: adminTok, body: { name: "clínica rdm" } })).status, 409);
  assert.equal((await call("POST", "/api/admin/tenants/NOEXISTE/connections", { token: adminTok, body: { name: "X" } })).status, 404);
});

test("admin: valida las URLs de la conexión", async () => {
  const bad = await call("PATCH", `/api/admin/tenants/t1/connections/${connId}`, { token: adminTok, body: { baseUrl: "no-es-url" } });
  assert.equal(bad.status, 400);
  const creds = await call("PATCH", `/api/admin/tenants/t1/connections/${connId}`, { token: adminTok, body: { baseUrl: "https://user:pass@host.com/x" } });
  assert.equal(creds.status, 400);
  assert.equal(db.connection._rows.find((c) => c.id === connId).baseUrl, clinic.baseUrl, "no se tocó");
});

test("admin: probar conexión", async () => {
  const r = await call("POST", `/api/admin/tenants/t1/connections/${connId}/test`, { token: adminTok });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal((await call("POST", `/api/admin/tenants/t1/connections/${connId}/test`, { token: ownerTok })).status, 403, "un usuario de centro no puede");
  assert.equal((await call("POST", `/api/admin/tenants/OTRO/connections/${connId}/test`, { token: adminTok })).status, 404, "no cruza centros");
});

test("admin: genera la clave de entrada de ESA clínica una sola vez y solo guarda su hash", async () => {
  const r = await call("POST", `/api/admin/tenants/t1/connections/${connId}/inbound-key`, { token: adminTok });
  assert.equal(r.status, 200);
  inboundKey = r.body.apiKey;
  assert.match(inboundKey, /^dosk_/);
  assert.equal(r.body.connectionName, "Clínica RDM");
  assert.match(r.body.fhirBaseUrl, /\/api\/fhir\/tenants\/t1$/, "la URL que se le entrega a la clínica");
  assert.match(r.body.serviceRequestUrl, /\/api\/fhir\/tenants\/t1\/ServiceRequest$/);
  const row = db.connection._rows.find((c) => c.id === connId);
  assert.equal(row.inboundKeyHash.length, 64);
  assert.ok(!JSON.stringify(row).includes(inboundKey));
});

test("FHIR entrada: sin clave o con clave mala => 401 en formato OperationOutcome", async () => {
  for (const headers of [{}, { "X-API-Key": "mala" }]) {
    const r = await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { body: serviceRequest("LO-X"), headers });
    assert.equal(r.status, 401);
    assert.equal(r.body.resourceType, "OperationOutcome");
  }
  assert.equal((await call("POST", "/api/fhir/tenants/NOEXISTE/ServiceRequest", { body: serviceRequest("LO-X"), headers: { "X-API-Key": inboundKey } })).status, 401);
  assert.equal((await call("GET", "/api/fhir/tenants/t1/metadata", { headers: { "X-API-Key": inboundKey } })).status, 200);
  assert.equal((await call("GET", "/api/fhir/tenants/t1/metadata", { headers: { Authorization: `Bearer ${inboundKey}` } })).status, 200, "también acepta Bearer");
  assert.equal(db.order._rows.length, 0);
});

test("FHIR entrada: crea orden + ESTUDIO del catálogo (emparejado por LOINC) + paciente por cédula", async () => {
  const r = await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { body: serviceRequest("LO-1001"), headers: { "X-API-Key": inboundKey } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ids = r.body._diagnosticOs;
  assert.equal(ids.studyIds.length, 1);
  const study = db.study._rows.find((s) => s.id === ids.studyIds[0]);
  assert.equal(study.serviceCode, "LAB-GLU");
  assert.equal(study.serviceName, "Glucosa en ayunas");
  assert.equal(study.modality, "LAB");
  assert.equal(study.externalStudyId, "LO-1001");
  const order = db.order._rows.find((o) => o.id === ids.orderId);
  assert.equal(order.externalOrderId, "LO-1001");
  assert.equal(order.sourceType, "HCE");
  assert.equal(order.connectionId, connId, "la orden queda marcada con la conexión (clínica) que la envió");
  assert.equal(order.sourceSystem, "Clínica RDM");
  assert.equal(order.externalSystem, "urn:clinicos:lab-order", "el system se guarda tal cual lo envió la clínica");
  const pat = db.patient._rows.find((p) => p.id === ids.patientId);
  assert.equal(pat.documentNumber, "0912345678", "tomó la cédula aunque no fuera el primer identificador");
  assert.equal(pat.matchStatus, "pendiente");
  assert.equal(pat.sourcePatientId, "clinicos-pat-77");
  assert.equal(pat.sourceSystem, "Clínica RDM");
  assert.deepEqual(pat.externalIdentifiers.map((e) => [e.system, e.value, e.connectionId]), [["urn:clinicos:patient", "77", connId], [`urn:diagnostic-os:connection:${connId}`, "clinicos-pat-77", connId]], "identificadores de la clínica, marcados con su conexión");
});

test("FHIR entrada: reenviar la misma orden NO la duplica (idempotente)", async () => {
  const before = { o: db.order._rows.length, s: db.study._rows.length, p: db.patient._rows.length };
  const r = await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { body: serviceRequest("LO-1001"), headers: { "X-API-Key": inboundKey } });
  assert.equal(r.status, 200);
  assert.equal(r.body._diagnosticOs.duplicate, true);
  assert.deepEqual({ o: db.order._rows.length, s: db.study._rows.length, p: db.patient._rows.length }, before);
  assert.ok(db.integrationMessage._rows.some((m) => m.status === "duplicate"));
});

test("FHIR entrada: estudio que no está en el catálogo se crea igual, con aviso", async () => {
  const sr = serviceRequest("LO-1002", { code: { text: "Ecografía de tiroides" } });
  const r = await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { body: sr, headers: { "X-API-Key": inboundKey } });
  assert.equal(r.status, 201);
  assert.ok(r.body.issue.some((i) => i.severity === "warning"));
  const study = db.study._rows.find((s) => s.id === r.body._diagnosticOs.studyIds[0]);
  assert.equal(study.serviceCode, "EXT-SIN-CATALOGO");
  assert.equal(study.modality, "ECO");
  assert.match(db.order._rows.find((o) => o.id === r.body._diagnosticOs.orderId).notes, /no encontrados en el catálogo/);
  assert.equal(db.patient._rows.filter((p) => p.documentNumber === "0912345678").length, 1, "mismo paciente, sin duplicar");
});

test("FHIR entrada: un Bundle con 2 ServiceRequest = 1 orden con 2 estudios", async () => {
  const bundle = { resourceType: "Bundle", type: "collection", entry: [{ resource: patientRes() }, { resource: { ...serviceRequest("LO-2001"), contained: undefined, requisition: { value: "REQ-9" } } }, { resource: { ...serviceRequest("LO-2002", { code: { text: "Hemograma" } }), contained: undefined, requisition: { value: "REQ-9" } } }] };
  const r = await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { body: bundle, headers: { "X-API-Key": inboundKey } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body._diagnosticOs.studyIds.length, 2);
  const studies = r.body._diagnosticOs.studyIds.map((id) => db.study._rows.find((s) => s.id === id));
  assert.deepEqual(studies.map((s) => s.externalStudyId), ["LO-2001", "LO-2002"]);
  assert.equal(db.order._rows.find((o) => o.id === r.body._diagnosticOs.orderId).externalOrderId, "REQ-9");
});

test("FHIR entrada: errores claros (sin paciente / recurso equivocado) y anulación de órdenes", async () => {
  const noPat = await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { body: { ...serviceRequest("LO-3"), contained: [] }, headers: { "X-API-Key": inboundKey } });
  assert.equal(noPat.status, 422);
  const wrong = await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { body: { resourceType: "Patient" }, headers: { "X-API-Key": inboundKey } });
  assert.equal(wrong.status, 400);
  const cancel = await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { body: serviceRequest("LO-1002", { status: "revoked" }), headers: { "X-API-Key": inboundKey } });
  assert.equal(cancel.status, 200);
  assert.equal(db.order._rows.find((o) => o.externalOrderId === "LO-1002").status, "cancelled");
});

test("FHIR entrada: un centro configurado con la versión anterior (una sola clave) se migra solo y su clave sigue valiendo", async () => {
  await db.tenant.create({ data: { id: "t-old", name: "Viejo", thirdPartyName: "Clinic-OS", thirdPartyApiKey: "clave-antigua-en-claro" } });
  await db.patient.create({ data: { id: "p-old", tenantId: "t-old", firstName: "A", lastName: "B", documentNumber: "55", externalIdentifiers: [{ system: "urn:x", value: "9" }] } });
  await db.order.create({ data: { id: "o-old", tenantId: "t-old", patientId: "p-old", sourceType: "HCE", externalOrderId: "7" } });
  assert.equal((await call("GET", "/api/fhir/tenants/t-old/metadata", { headers: { "X-API-Key": "mala" } })).status, 401);
  const ok = await call("GET", "/api/fhir/tenants/t-old/metadata", { headers: { "X-API-Key": "clave-antigua-en-claro" } });
  assert.equal(ok.status, 200);
  assert.match(ok.body.implementation.description, /Viejo · conexión "Clinic-OS"/);
  const conns = db.connection._rows.filter((c) => c.tenantId === "t-old");
  assert.equal(conns.length, 1, "se creó UNA conexión");
  assert.equal(db.order._rows.find((o) => o.id === "o-old").connectionId, conns[0].id, "sus órdenes quedaron marcadas");
  assert.equal(db.patient._rows.find((p) => p.id === "p-old").externalIdentifiers[0].connectionId, conns[0].id, "y los ids de sus pacientes también");
  const t = db.tenant._rows.find((x) => x.id === "t-old");
  assert.equal(t.thirdPartyApiKey, null, "los secretos antiguos ya no quedan en el centro");
  assert.equal((await call("GET", "/api/fhir/tenants/t-old/metadata", { headers: { "X-API-Key": "clave-antigua-en-claro" } })).status, 200, "la misma clave sigue funcionando");
  assert.equal(db.connection._rows.filter((c) => c.tenantId === "t-old").length, 1, "idempotente");
});

// ------------------------ ciclo completo desde la app (estado) ---------------------------------

test("CICLO COMPLETO: orden entrante + navegador desactualizado + publicar => llega a Clinic-OS", async () => {
  // 1) el usuario abre la app (carga su estado)
  const loaded = (await call("GET", "/api/state", { token: ownerTok })).body;
  assert.ok(loaded.serverTime);
  const order1 = loaded.orders.find((o) => o.externalOrderId === "LO-1001");
  const study1 = loaded.studies.find((s) => s.orderId === order1.id);
  assert.ok(order1 && study1, "el usuario ve la orden que mandó el HCE");

  // 2) MIENTRAS tanto llega otra orden del HCE (el navegador no se entera)
  const late = await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { body: serviceRequest("LO-5000"), headers: { "X-API-Key": inboundKey } });
  assert.equal(late.status, 201);
  const lateOrderId = late.body._diagnosticOs.orderId;

  // 3) el laboratorista ingresa resultado, valida y publica -> el navegador guarda SU lista (sin la orden nueva)
  const result = { id: "res-1", studyId: study1.id, analyte: "Glucosa", value: "92", unit: "mg/dL", referenceRange: "70-100", flag: "normal", status: "validated" };
  const report = { id: "rep-1", studyId: study1.id, orderId: order1.id, patientId: order1.patientId, type: "LAB", status: "published", resultIds: ["res-1"], version: 1, conclusion: "Normal", author: { userId: "u-owner", name: "Dra. Andrade" }, publishedAt: new Date().toISOString() };
  const put = await call("PUT", "/api/state", { token: ownerTok, body: { loadedAt: loaded.serverTime, patients: loaded.patients, orders: loaded.orders, studies: loaded.studies, results: [result], diagnosticReports: [report], integrationMessages: [] } });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  // la orden tardía SOBREVIVIÓ (antes el guardado automático la habría borrado)
  assert.ok(db.order._rows.some((o) => o.id === lateOrderId), "la orden que llegó mientras tanto no se borró");
  assert.ok(db.study._rows.some((s) => s.orderId === lateOrderId), "sus estudios tampoco");
  // y los mensajes reales del servidor tampoco (el navegador mandó una lista vacía)
  assert.ok(db.integrationMessage._rows.some((m) => m.type === "ServiceRequestReceived"));

  // 4) el informe llegó a Clinic-OS, solo, sin que nadie toque nada más
  await until(() => clinic.state.received.length === 1);
  const sent = clinic.state.received[0];
  assert.equal(sent.key, "rep-1:v1");
  assert.equal(sent.body.subject.identifier.value, "0912345678");
  assert.equal(sent.body.basedOn[0].identifier.value, "LO-1001", "vinculado a la orden original de Clinic-OS");
  assert.equal(sent.body.basedOn[0].identifier.system, "urn:clinicos:lab-order");
  assert.match(sent.body.conclusion, /Glucosa: 92 mg\/dL \(ref\. 70-100\)/, "los valores del examen viajan en el texto");
  await until(() => db.integrationMessage._rows.some((m) => m.type === "ReportPublished" && m.status === "acknowledged"));
});

test("guardar de nuevo el mismo estado NO reenvía el informe", async () => {
  const loaded = (await call("GET", "/api/state", { token: ownerTok })).body;
  await call("PUT", "/api/state", { token: ownerTok, body: { loadedAt: loaded.serverTime, diagnosticReports: loaded.diagnosticReports } });
  await sleep(150);
  assert.equal(clinic.state.received.length, 1);
});

test("corrección: 'amended' (en edición) no envía; al republicar la v2 se envía como 'amended'", async () => {
  let s = (await call("GET", "/api/state", { token: ownerTok })).body;
  const rep = s.diagnosticReports.find((r) => r.id === "rep-1");
  await call("PUT", "/api/state", { token: ownerTok, body: { loadedAt: s.serverTime, diagnosticReports: [{ ...rep, status: "amended", version: 2, amendmentReason: "Error de unidad" }] } });
  await sleep(150);
  assert.equal(clinic.state.received.length, 1, "aún no se republicó");

  s = (await call("GET", "/api/state", { token: ownerTok })).body;
  await call("PUT", "/api/state", { token: ownerTok, body: { loadedAt: s.serverTime, diagnosticReports: [{ ...rep, status: "published", version: 2, amendmentReason: "Error de unidad", conclusion: "Normal (corregido)" }] } });
  await until(() => clinic.state.received.length === 2);
  assert.equal(clinic.state.received[1].key, "rep-1:v2");
  assert.equal(clinic.state.received[1].body.meta.versionId, "2");
  assert.match(clinic.state.received[1].body.conclusion, /Normal \(corregido\)/);
});

test("el usuario SÍ puede borrar lo que él mismo creó o ya conocía (la protección no se lo impide)", async () => {
  const s = (await call("GET", "/api/state", { token: ownerTok })).body;
  const mine = { id: "pat-mio", firstName: "Luis", lastName: "Paz", documentType: "cedula", documentNumber: "1111111111" };
  // el navegador crea un paciente y lo guarda
  await call("PUT", "/api/state", { token: ownerTok, body: { loadedAt: s.serverTime, patients: [...s.patients, mine] } });
  assert.ok(db.patient._rows.some((p) => p.id === "pat-mio"));
  // ...y después lo elimina, SIN haber recargado (loadedAt viejo): como él mismo lo mandó, se borra
  await call("PUT", "/api/state", { token: ownerTok, body: { loadedAt: s.serverTime, patients: s.patients } });
  assert.ok(!db.patient._rows.some((p) => p.id === "pat-mio"), "borrado");
  // y lo que llegó de afuera sigue ahí
  assert.ok(s.patients.every((p) => db.patient._rows.some((x) => x.id === p.id)));
});

test("navegador viejo sin loadedAt: igual protege lo que llegó hace poco", async () => {
  const s = (await call("GET", "/api/state", { token: ownerTok })).body;
  const r = await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { body: serviceRequest("LO-7000", { contained: [patientRes({ identifier: [{ system: "urn:ec:cedula", value: "1700000001" }] })] }), headers: { "X-API-Key": inboundKey } });
  const orderId = r.body._diagnosticOs.orderId;
  // el navegador (versión vieja, no manda loadedAt) guarda lo que tenía antes de que llegara esa orden
  await call("PUT", "/api/state", { token: ownerTok, body: { patients: s.patients, orders: s.orders, studies: s.studies } });
  assert.ok(db.order._rows.some((o) => o.id === orderId), "la orden nueva sobrevive");
  assert.ok(db.order._rows.some((o) => o.externalOrderId === "LO-1001"), "y lo anterior sigue igual");
});

test("reenvío manual desde la app (botón 'Compartir con sistemas externos')", async () => {
  const before = clinic.state.received.length;
  const r = await call("POST", "/api/reports/rep-1/resend", { token: ownerTok });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "acknowledged");
  assert.equal(clinic.state.received.length, before + 1);
  assert.equal((await call("POST", "/api/reports/NOEXISTE/resend", { token: ownerTok })).status, 409);
});

test("admin: reintentar un mensaje fallido a mano", async () => {
  clinic.state.failNext = 1;
  const r1 = await call("POST", "/api/reports/rep-1/resend", { token: ownerTok });
  assert.equal(r1.body.ok, false);
  const failed = db.integrationMessage._rows.find((m) => m.status === "failed");
  assert.ok(failed);
  const retry = await call("POST", `/api/admin/tenants/t1/integrations/messages/${failed.id}/retry`, { token: adminTok });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.message.status, "acknowledged");
  assert.equal((await call("POST", `/api/admin/tenants/OTRO/integrations/messages/${failed.id}/retry`, { token: adminTok })).status, 404, "no cruza centros");
});

test("admin: quitar el destino de retorno borra TODOS los secretos de salida (la clave de entrada se cambia aparte)", async () => {
  const r = await call("PATCH", `/api/admin/tenants/t1/connections/${connId}`, { token: adminTok, body: { disconnect: true } });
  assert.equal(r.status, 200);
  const row = db.connection._rows.find((c) => c.id === connId);
  assert.equal(row.baseUrl, null);
  assert.equal(row.clientSecret, null);
  assert.equal(row.apiKey, null);
  assert.ok(row.inboundKeyHash, "la clave de entrada se revoca generando otra, no al quitar el retorno");
});

test("admin: una conexión con órdenes no se puede eliminar (solo desactivar); una vacía sí", async () => {
  const del = await call("DELETE", `/api/admin/tenants/t1/connections/${connId}`, { token: adminTok });
  assert.equal(del.status, 409);
  assert.match(del.body.error, /Desactívala/);
  const off = await call("PATCH", `/api/admin/tenants/t1/connections/${connId}`, { token: adminTok, body: { enabled: false } });
  assert.equal(off.body.enabled, false);
  assert.equal((await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { body: serviceRequest("LO-9"), headers: { "X-API-Key": inboundKey } })).status, 403, "desactivada: la clínica ya no puede enviar");
  const tmp = await call("POST", "/api/admin/tenants/t1/connections", { token: adminTok, body: { name: "Temporal" } });
  assert.equal((await call("DELETE", `/api/admin/tenants/t1/connections/${tmp.body.id}`, { token: adminTok })).status, 200);
});
