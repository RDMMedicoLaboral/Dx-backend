// Un laboratorio conectado con VARIAS clínicas a la vez: lo que NUNCA debe pasar es que se mezclen
// órdenes, resultados o datos de pacientes entre clínicas.
import { test, after } from "node:test";
import assert from "node:assert/strict";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";

await import("../src/lib/asyncErrors.js");
const express = (await import("express")).default;
const { prisma: db } = await import("./fakePrisma.mjs");
const { startFakeClinicOs } = await import("./fakeClinicOs.mjs");
const { signToken } = await import("../src/middleware/auth.js");
const { encryptSecret, sha256Hex } = await import("../src/lib/secrets.js");
const { createIntegration } = await import("../src/lib/integrationCore.js");

const fhirRoutes = (await import("../src/routes/fhir.js")).default;
const clinicalRoutes = (await import("../src/routes/clinical.js")).default;
const stateRoutes = (await import("../src/routes/state.js")).default;

const keyA = "dosk_" + "a".repeat(64);
const keyB = "dosk_" + "b".repeat(64);
const keyOtherLab = "dosk_" + "c".repeat(64);
let server, base, clinicA, clinicB, ownerTok;

const call = async (method, path, { token, body, key } = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { "X-API-Key": key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* vacío */ }
  return { status: res.status, body: json };
};
const sr = (value, patientId, name = "Glucosa en ayunas") => ({
  resourceType: "ServiceRequest", status: "active", intent: "order",
  identifier: [{ system: "urn:clinicos:lab-order", value }], // ¡las dos clínicas usan el MISMO sistema y el MISMO número!
  code: { text: name }, subject: { reference: "#pat" },
  contained: [{ resourceType: "Patient", id: patientId, identifier: [{ system: "urn:ec:cedula", value: "0912345678" }, { system: "urn:clinica:interno", value: `int-${patientId}` }], name: [{ family: "Mora", given: ["Ana"] }], gender: "female", birthDate: "1990-05-01" }],
});
const publish = async (orderId, conclusion) => {
  const o = db.order._rows.find((x) => x.id === orderId);
  const st = db.study._rows.find((x) => x.orderId === orderId);
  return db.diagnosticReport.create({ data: { tenantId: "t1", studyId: st.id, orderId, patientId: o.patientId, type: "LAB", status: "published", conclusion, resultIds: [], version: 1, publishedAt: new Date() } });
};

test("(preparación) un laboratorio con dos clínicas y un tercer centro aparte", async () => {
  clinicA = await startFakeClinicOs({ clientId: "rdm", clientSecret: "secret-rdm" });
  clinicB = await startFakeClinicOs({ clientId: "santaana", clientSecret: "secret-santaana" });
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/fhir", fhirRoutes);
  app.use("/api/state", stateRoutes);
  app.use("/api", clinicalRoutes);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;

  await db.tenant.create({ data: { id: "t1", name: "Laboratorio Narcisa de Jesús", kind: "Laboratorio" } });
  await db.tenant.create({ data: { id: "t2", name: "Otro Laboratorio", kind: "Laboratorio" } });
  await db.catalogItem.create({ data: { tenantId: "t1", code: "LAB-GLU", name: "Glucosa en ayunas", modality: "LAB", externalCodes: [], active: true } });
  await db.user.create({ data: { id: "u1", tenantId: "t1", name: "Dueña", email: "o@x", role: "dueno", passwordHash: "x" } });
  ownerTok = signToken({ id: "u1", tenantId: "t1", role: "dueno", name: "Dueña", email: "o@x" });
  await db.connection.create({ data: { id: "cA", tenantId: "t1", name: "Clínica RDM", inboundKeyHash: sha256Hex(keyA), baseUrl: clinicA.baseUrl, clientId: "rdm", clientSecret: encryptSecret("secret-rdm") } });
  await db.connection.create({ data: { id: "cB", tenantId: "t1", name: "Clínica Santa Ana", inboundKeyHash: sha256Hex(keyB), baseUrl: clinicB.baseUrl, clientId: "santaana", clientSecret: encryptSecret("secret-santaana") } });
  await db.connection.create({ data: { id: "cX", tenantId: "t2", name: "Clínica RDM", inboundKeyHash: sha256Hex(keyOtherLab) } });
});
after(async () => { server?.closeAllConnections?.(); await new Promise((r) => server.close(r)); await clinicA.close(); await clinicB.close(); });

test("la orden '5' de la clínica A y la orden '5' de la clínica B son DOS órdenes distintas", async () => {
  const a = await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { key: keyA, body: sr("5", "A-77") });
  const b = await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { key: keyB, body: sr("5", "B-31") });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.notEqual(a.body._diagnosticOs.orderId, b.body._diagnosticOs.orderId);
  const oa = db.order._rows.find((o) => o.id === a.body._diagnosticOs.orderId);
  const ob = db.order._rows.find((o) => o.id === b.body._diagnosticOs.orderId);
  assert.equal(oa.connectionId, "cA");
  assert.equal(ob.connectionId, "cB");
  assert.equal(oa.externalOrderId, "5");
  assert.equal(ob.externalOrderId, "5");
  assert.equal(oa.sourceSystem, "Clínica RDM");
  assert.equal(ob.sourceSystem, "Clínica Santa Ana");
  // mismo paciente del laboratorio (misma cédula): UNA sola ficha
  assert.equal(db.patient._rows.filter((p) => p.tenantId === "t1").length, 1);
});

test("reenviar la orden '5' de A solo devuelve 'ya existía' la de A (nunca la de B)", async () => {
  const again = await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { key: keyA, body: sr("5", "A-77") });
  assert.equal(again.status, 200);
  assert.equal(again.body._diagnosticOs.duplicate, true);
  assert.equal(db.order._rows.find((o) => o.id === again.body._diagnosticOs.orderId).connectionId, "cA");
  assert.equal(db.order._rows.filter((o) => o.tenantId === "t1").length, 2, "no se creó una tercera");
});

test("la anulación de A no toca la orden '5' de B", async () => {
  await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { key: keyA, body: { ...sr("5", "A-77"), status: "revoked" } });
  assert.equal(db.order._rows.find((o) => o.connectionId === "cA").status, "cancelled");
  assert.notEqual(db.order._rows.find((o) => o.connectionId === "cB").status, "cancelled");
  // A la vuelve a enviar activa (para seguir con el resto de pruebas) -> como ya existe, queda igual; restauramos a mano
  await db.order.update({ where: { id: db.order._rows.find((o) => o.connectionId === "cA").id }, data: { status: "active" } });
});

test("una clave solo sirve para SU laboratorio y SU conexión; una conexión desactivada no entra", async () => {
  assert.equal((await call("POST", "/api/fhir/tenants/t2/ServiceRequest", { key: keyA, body: sr("1", "x") })).status, 401, "la clave de A no abre el laboratorio t2");
  assert.equal((await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { key: keyOtherLab, body: sr("1", "x") })).status, 401, "la clave de t2 no abre t1");
  assert.equal((await call("GET", "/api/fhir/tenants/t1/metadata", { key: keyA })).body.implementation.description, 'Laboratorio Narcisa de Jesús · conexión "Clínica RDM"');
  assert.equal((await call("GET", "/api/fhir/tenants/t1/metadata", { key: keyB })).body.implementation.description, 'Laboratorio Narcisa de Jesús · conexión "Clínica Santa Ana"');
  await db.connection.update({ where: { id: "cB" }, data: { enabled: false } });
  assert.equal((await call("GET", "/api/fhir/tenants/t1/metadata", { key: keyB })).status, 403);
  assert.equal((await call("GET", "/api/fhir/tenants/t1/metadata", { key: keyA })).status, 200, "A sigue funcionando");
  await db.connection.update({ where: { id: "cB" }, data: { enabled: true } });
});

test("los resultados vuelven a la clínica que pidió el examen — y SOLO a ella", async () => {
  const oa = db.order._rows.find((o) => o.connectionId === "cA");
  const ob = db.order._rows.find((o) => o.connectionId === "cB");
  const ra = await publish(oa.id, "Resultado de la clínica A");
  const rb = await publish(ob.id, "Resultado de la clínica B");

  const sendA = await call("POST", `/api/reports/${ra.id}/resend`, { token: ownerTok });
  assert.equal(sendA.body.status, "acknowledged", JSON.stringify(sendA.body));
  assert.equal(clinicA.state.received.length, 1);
  assert.equal(clinicB.state.received.length, 0, "B no recibe el informe de A");

  const sendB = await call("POST", `/api/reports/${rb.id}/resend`, { token: ownerTok });
  assert.equal(sendB.body.status, "acknowledged");
  assert.equal(clinicA.state.received.length, 1, "A no recibe el informe de B");
  assert.equal(clinicB.state.received.length, 1);

  assert.match(clinicA.state.received[0].body.conclusion, /clínica A/);
  assert.match(clinicB.state.received[0].body.conclusion, /clínica B/);
  // Cada una recibe el identificador EXACTO con que ella nombró su orden
  assert.deepEqual(clinicA.state.received[0].body.basedOn, [{ identifier: { system: "urn:clinicos:lab-order", value: "5" } }]);
  assert.deepEqual(clinicB.state.received[0].body.basedOn, [{ identifier: { system: "urn:clinicos:lab-order", value: "5" } }]);
  // y cada mensaje del registro queda atado a su conexión
  const out = db.integrationMessage._rows.filter((m) => m.type === "ReportPublished");
  assert.deepEqual(out.map((m) => [m.entityId === ra.id ? "A" : "B", m.connectionId, m.destination]).sort(), [["A", "cA", "Clínica RDM"], ["B", "cB", "Clínica Santa Ana"]]);
});

test("la clínica B NO puede leer informes ni pacientes que solo conoce A", async () => {
  const oa = db.order._rows.find((o) => o.connectionId === "cA");
  const ra = db.diagnosticReport._rows.find((r) => r.orderId === oa.id);
  assert.equal((await call("GET", `/api/fhir/tenants/t1/DiagnosticReport/${ra.id}`, { key: keyB })).status, 404, "informe de A leído con la clave de B");
  assert.equal((await call("GET", `/api/fhir/tenants/t1/DiagnosticReport/${ra.id}`, { key: keyA })).status, 200, "A sí puede leer el suyo");

  // un paciente que solo envió A
  const solo = await call("POST", "/api/fhir/tenants/t1/ServiceRequest", { key: keyA, body: { ...sr("6", "A-99"), contained: [{ resourceType: "Patient", id: "A-99", identifier: [{ system: "urn:ec:cedula", value: "1700000001" }], name: [{ family: "Solo", given: ["Pedro"] }] }] } });
  const pid = solo.body._diagnosticOs.patientId;
  assert.equal((await call("GET", `/api/fhir/tenants/t1/Patient/${pid}`, { key: keyB })).status, 404);
  assert.equal((await call("GET", `/api/fhir/tenants/t1/Patient/${pid}`, { key: keyA })).status, 200);
});

test("el paciente compartido solo muestra a cada clínica SUS propios identificadores", async () => {
  const pid = db.patient._rows.find((p) => p.documentNumber === "0912345678").id;
  const forB = await call("GET", `/api/fhir/tenants/t1/Patient/${pid}`, { key: keyB });
  assert.equal(forB.status, 200);
  const values = forB.body.identifier.map((i) => i.value);
  assert.ok(values.includes("int-B-31"), "ve el suyo");
  assert.ok(!values.some((v) => String(v).includes("A-77")), "NO ve los ids internos de la clínica A: " + values.join(","));
  const forA = await call("GET", `/api/fhir/tenants/t1/Patient/${pid}`, { key: keyA });
  assert.ok(!forA.body.identifier.map((i) => i.value).some((v) => String(v).includes("B-31")));
});

test("el informe saliente (perfil completo) tampoco filtra datos de otras clínicas", async () => {
  const ob = db.order._rows.find((o) => o.connectionId === "cB");
  const rb = db.diagnosticReport._rows.find((r) => r.orderId === ob.id);
  let sent = null;
  const integ = createIntegration({ db, profileOverride: "full", log: { warn() {}, error() {} }, fetchImpl: async (url, opts) => {
    if (String(url).includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 900 }), { status: 200 });
    sent = JSON.parse(opts.body); return new Response("{}", { status: 200 });
  } });
  const r = await integ.pushReport("t1", rb.id, { force: true });
  assert.equal(r.message.status, "acknowledged");
  const text = JSON.stringify(sent);
  assert.ok(text.includes("int-B-31"));
  assert.ok(!text.includes("A-77"), "el informe para B no lleva ids de la clínica A");
  assert.ok(!text.includes("int-A-77"));
});

test("barrera final: un envío NUNCA sale hacia una conexión distinta de la de su orden", async () => {
  const oa = db.order._rows.find((o) => o.connectionId === "cA");
  const ra = db.diagnosticReport._rows.find((r) => r.orderId === oa.id);
  const before = clinicB.state.received.length;
  // Mensaje "mal armado": informe de A atado a la conexión de B (como si hubiera un error en otra parte)
  const bad = await db.integrationMessage.create({ data: { tenantId: "t1", connectionId: "cB", type: "ReportPublished", direction: "outbound", source: "DX", destination: "Clínica Santa Ana", status: "failed", entityType: "DiagnosticReport", entityId: ra.id, eventId: `report:${ra.id}:v1` } });
  const integ = createIntegration({ db, log: { warn() {}, error() {} } });
  const r = await integ.retryMessage(bad.id, { manual: true });
  assert.equal(r.message.status, "failed");
  assert.match(r.message.lastError, /Bloqueado/);
  assert.equal(r.message.nextRetryAt, null, "no se reintenta");
  assert.equal(clinicB.state.received.length, before, "B no recibió nada");
});

test("un informe de una orden creada dentro del laboratorio no se envía a nadie", async () => {
  const p = db.patient._rows[0];
  const o = await db.order.create({ data: { tenantId: "t1", patientId: p.id, sourceType: "interno" } });
  const st = await db.study.create({ data: { tenantId: "t1", orderId: o.id, patientId: p.id, serviceCode: "X", serviceName: "X", modality: "LAB" } });
  const rep = await db.diagnosticReport.create({ data: { tenantId: "t1", studyId: st.id, orderId: o.id, patientId: p.id, type: "LAB", status: "published", version: 1 } });
  const a = clinicA.state.received.length, b = clinicB.state.received.length;
  const r = await call("POST", `/api/reports/${rep.id}/resend`, { token: ownerTok });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no viene de ninguna clínica/);
  assert.equal(clinicA.state.received.length + clinicB.state.received.length, a + b);
});

test("el personal del laboratorio ve de qué clínica es cada orden, sin claves ni URLs", async () => {
  const s = (await call("GET", "/api/state", { token: ownerTok })).body;
  assert.deepEqual(s.connections.map((c) => [c.id, c.name, c.enabled]).sort(), [["cA", "Clínica RDM", true], ["cB", "Clínica Santa Ana", true]]);
  assert.ok(!JSON.stringify(s.connections).includes("secret"));
  assert.ok(!JSON.stringify(s.connections).includes("http"));
  assert.ok(!JSON.stringify(s.connections).includes("Hash"));
  const byConn = Object.fromEntries(s.orders.filter((o) => o.connectionId).map((o) => [o.connectionId, o.sourceSystem]));
  assert.equal(byConn.cA, "Clínica RDM");
  assert.equal(byConn.cB, "Clínica Santa Ana");
  assert.ok(!JSON.stringify(s).includes("inboundKeyHash"));
});

test("guardar el estado desde el navegador no pierde la conexión de la orden ni los identificadores por clínica", async () => {
  const s = (await call("GET", "/api/state", { token: ownerTok })).body;
  // el navegador devuelve sus listas tal cual (como hace la app) pero SIN los campos nuevos
  const stripped = s.orders.map(({ connectionId, externalSystem, ...rest }) => rest);
  const strippedPatients = s.patients.map(({ externalIdentifiers, ...rest }) => rest);
  await call("PUT", "/api/state", { token: ownerTok, body: { loadedAt: s.serverTime, orders: stripped, patients: strippedPatients } });
  const after = db.order._rows.filter((o) => o.externalOrderId === "5");
  assert.deepEqual(after.map((o) => o.connectionId).sort(), ["cA", "cB"]);
  assert.ok(after.every((o) => o.externalSystem === "urn:clinicos:lab-order"));
  const pat = db.patient._rows.find((p) => p.documentNumber === "0912345678");
  assert.ok(pat.externalIdentifiers.some((e) => e.connectionId === "cA") && pat.externalIdentifiers.some((e) => e.connectionId === "cB"));
});
