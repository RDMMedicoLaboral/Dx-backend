import { test, before, after } from "node:test";
import assert from "node:assert/strict";
process.env.JWT_SECRET = "test-secret";

const { makeDb } = await import("./fakeDb.mjs");
const { startFakeClinicOs } = await import("./fakeClinicOs.mjs");
const { createIntegration, MAX_ATTEMPTS } = await import("../src/lib/integrationCore.js");
const { encryptSecret } = await import("../src/lib/secrets.js");

let clock = new Date("2026-10-15T12:00:00Z");
const now = () => new Date(clock);
const advance = (min) => { clock = new Date(clock.getTime() + min * 60000); };
const quiet = { warn() {}, error() {} };

let clinic, db, integ;

async function seed(connPatch = {}) {
  db = makeDb({ now });
  clinic = await startFakeClinicOs();
  await db.tenant.create({ data: { id: "t1", name: "Lab San Rafael" } });
  await db.connection.create({ data: { id: "c1", tenantId: "t1", name: "Clínica RDM", baseUrl: clinic.baseUrl, authType: "oauth2", clientId: clinic.clientId, clientSecret: encryptSecret(clinic.clientSecret), ...connPatch } });
  await db.patient.create({ data: { id: "p1", tenantId: "t1", firstName: "Ana", lastName: "Mora", documentNumber: "0912345678", sex: "F", birthDate: "1990-05-01" } });
  await db.order.create({ data: { id: "o1", tenantId: "t1", patientId: "p1", connectionId: "c1", externalOrderId: "LO-1001", externalSystem: "urn:clinicos:lab-order", sourceType: "HCE" } });
  await db.study.create({ data: { id: "s1", tenantId: "t1", orderId: "o1", patientId: "p1", serviceCode: "LAB-GLU", serviceName: "Glucosa en ayunas", modality: "LAB", externalStudyId: "LO-1001" } });
  await db.result.create({ data: { id: "x1", tenantId: "t1", studyId: "s1", analyte: "Glucosa", value: "92", unit: "mg/dL", referenceRange: "70-100", status: "validated" } });
  await db.diagnosticReport.create({ data: { id: "r1", tenantId: "t1", studyId: "s1", orderId: "o1", patientId: "p1", type: "LAB", status: "published", resultIds: ["x1"], conclusion: "Normal", authorName: "Lic. Loor", publishedAt: now() } });
  await db.attachment.create({ data: { tenantId: "t1", entityType: "DiagnosticReport", entityId: "r1", url: "https://res.cloudinary.com/x/inf.pdf", publicId: "x", resourceType: "raw", format: "pdf", bytes: 10, caption: "Informe" } });
  integ = createIntegration({ db, now, log: quiet });
}
const msgs = () => db.integrationMessage._rows;

before(() => { process.env.NODE_ENV = "test"; });
after(async () => { await clinic?.close(); });

test("camino feliz (perfil Clinic-OS): token por JSON + cédula + orden original + texto con los valores", async () => {
  await seed();
  const r = await integ.pushReport("t1", "r1");
  assert.equal(r.message.status, "acknowledged");
  assert.equal(clinic.state.tokenRequests.length, 1);
  assert.deepEqual(clinic.state.tokenRequests[0], { mode: "json", scope: "system/DiagnosticReport.write", grant: "client_credentials" });

  const got = clinic.state.received[0];
  assert.equal(got.contentType, "application/json");
  assert.equal(got.key, "r1:v1");
  const b = got.body;
  assert.deepEqual(b.subject, { identifier: { system: "urn:ec:cedula", value: "0912345678" } }, "paciente solo por cédula, sin referencias internas");
  assert.deepEqual(b.basedOn, [{ identifier: { system: "urn:clinicos:lab-order", value: "LO-1001" } }]);
  assert.equal(b.meta.versionId, "1");
  assert.equal(b.status, "final");
  assert.match(b.conclusion, /^Normal\n\nResultados:\n- Glucosa: 92 mg\/dL \(ref\. 70-100\)$/);
  assert.equal(b.contained, undefined, "perfil Clinic-OS: sin recursos contenidos");
  assert.equal(msgs()[0].entityId, "r1");
  assert.equal(msgs()[0].nextRetryAt, null);
  await clinic.close();
});

test("perfil 'full': FHIR autocontenido con Observations, paciente y adjuntos", async () => {
  await seed();
  integ = createIntegration({ db, now, log: quiet, profileOverride: "full" });
  const r = await integ.pushReport("t1", "r1");
  assert.equal(r.message.status, "acknowledged");
  const b = clinic.state.received[0].body;
  assert.equal(b.subject.identifier.value, "0912345678");
  assert.equal(b.contained.filter((c) => c.resourceType === "Observation").length, 1);
  assert.equal(b.contained.find((c) => c.resourceType === "Observation").valueQuantity.value, 92);
  assert.equal(b.presentedForm[0].contentType, "application/pdf");
  await clinic.close();
});

test("se OMITE (sin llamar a la red) si la orden no vino de Clinic-OS o el paciente no tiene cédula", async () => {
  await seed();
  await db.order.update({ where: { id: "o1" }, data: { externalOrderId: null } });
  await db.study.update({ where: { id: "s1" }, data: { externalStudyId: null } });
  const a = await integ.pushReport("t1", "r1");
  assert.equal(a.message.status, "skipped");
  assert.match(a.message.payloadSummary, /NO enviado: La orden no viene de Clinic-Os/);
  assert.equal(a.message.nextRetryAt, null);
  assert.equal(clinic.state.tokenRequests.length + clinic.state.received.length, 0);

  await db.order.update({ where: { id: "o1" }, data: { externalOrderId: "LO-1001" } });
  await db.patient.update({ where: { id: "p1" }, data: { documentType: "pasaporte" } });
  const b = await integ.pushReport("t1", "r1", { force: true });
  assert.equal(b.message.status, "skipped");
  assert.match(b.message.payloadSummary, /sin cédula|no tiene cédula/);
  advance(100000);
  assert.equal(await integ.retryDue(), 0, "lo omitido no se reintenta");
  await clinic.close();
});

test("el token se reutiliza entre envíos (no se pide uno por cada informe)", async () => {
  await seed();
  await integ.pushReport("t1", "r1");
  await db.diagnosticReport.update({ where: { id: "r1" }, data: { version: 2 } });
  await integ.pushReport("t1", "r1");
  assert.equal(clinic.state.tokenRequests.length, 1);
  assert.equal(clinic.state.received.length, 2);
  assert.equal(clinic.state.received[1].body.meta.versionId, "2");
  assert.equal(clinic.state.received[1].key, "r1:v2");
  await clinic.close();
});

test("si el token venció, pide uno nuevo y reintenta en el mismo envío", async () => {
  await seed();
  await integ.pushReport("t1", "r1");
  clinic.state.expireAll = true; // el servidor "olvida" los tokens
  await db.diagnosticReport.update({ where: { id: "r1" }, data: { version: 2 } });
  const r = await integ.pushReport("t1", "r1");
  assert.equal(r.message.status, "acknowledged");
  assert.equal(clinic.state.tokenRequests.length, 2);
  await clinic.close();
});

test("sirve con servidores OAuth2 'de libro' (formulario o HTTP Basic): prueba las formas y recuerda la que funciona", async () => {
  for (const [style, expected] of [["form", ["json", "form"]], ["basic", ["json", "form", "basic"]]]) {
    db = makeDb({ now });
    clinic = await startFakeClinicOs({ authStyle: style });
    await db.tenant.create({ data: { id: "t1", name: "L" } });
    await db.connection.create({ data: { id: "c1", tenantId: "t1", name: "Clínica", baseUrl: clinic.baseUrl, authType: "oauth2", clientId: clinic.clientId, clientSecret: encryptSecret(clinic.clientSecret) } });
    await db.patient.create({ data: { id: "p1", tenantId: "t1", firstName: "A", lastName: "B", documentNumber: "1" } });
    await db.order.create({ data: { id: "o1", tenantId: "t1", patientId: "p1", connectionId: "c1", externalOrderId: "9" } });
    await db.study.create({ data: { id: "s1", tenantId: "t1", orderId: "o1", patientId: "p1", serviceCode: "X", serviceName: "X", modality: "LAB" } });
    await db.diagnosticReport.create({ data: { id: "r1", tenantId: "t1", studyId: "s1", orderId: "o1", patientId: "p1", type: "LAB", status: "published" } });
    integ = createIntegration({ db, now, log: quiet });
    assert.equal((await integ.pushReport("t1", "r1")).message.status, "acknowledged", style);
    assert.deepEqual(clinic.state.tokenRequests.map((t) => t.mode), expected, style);
    await integ.pushReport("t1", "r1", { force: true });
    assert.equal(clinic.state.tokenRequests.length, expected.length, "ya recuerda la forma que funcionó");
    await clinic.close();
  }
});

test("falla transitoria (503): queda 'failed' con próxima fecha y el reintento automático lo entrega", async () => {
  await seed();
  clinic.state.failNext = 1; clinic.state.failStatus = 503;
  const r = await integ.pushReport("t1", "r1");
  assert.equal(r.message.status, "failed");
  assert.match(r.message.lastError, /503/);
  assert.ok(r.message.nextRetryAt > now());
  assert.equal(r.message.attempts, 1);

  assert.equal(await integ.retryDue(), 0, "todavía no toca");
  advance(2);
  assert.equal(await integ.retryDue(), 1);
  assert.equal(msgs()[0].status, "acknowledged");
  assert.equal(msgs()[0].attempts, 2);
  assert.equal(msgs()[0].lastError, null);
  assert.equal(msgs()[0].nextRetryAt, null);
  assert.equal(clinic.state.received.length, 1);
  await clinic.close();
});

test("espera creciente y tope de intentos", async () => {
  await seed();
  clinic.state.failNext = 99; clinic.state.failStatus = 500;
  let r = await integ.pushReport("t1", "r1");
  const waits = [Math.round((r.message.nextRetryAt - now()) / 60000)];
  for (let i = 2; i <= MAX_ATTEMPTS; i++) {
    advance(500);
    await integ.retryDue();
    const m = msgs()[0];
    assert.equal(m.attempts, i);
    if (i < MAX_ATTEMPTS) waits.push(Math.round((m.nextRetryAt - now()) / 60000));
  }
  assert.deepEqual(waits, [1, 5, 15, 60, 240]);
  assert.equal(msgs()[0].status, "failed");
  assert.equal(msgs()[0].nextRetryAt, null, "agotó los intentos automáticos");
  advance(10000);
  assert.equal(await integ.retryDue(), 0);
  // pero a mano sí se puede reintentar cuando el destino se recupera
  clinic.state.failNext = 0;
  const manual = await integ.retryMessage(msgs()[0].id, { manual: true });
  assert.equal(manual.message.status, "acknowledged");
  await clinic.close();
});

test("falla permanente (422): NO se reintenta sola", async () => {
  await seed();
  clinic.state.failNext = 1; clinic.state.failStatus = 422;
  const r = await integ.pushReport("t1", "r1");
  assert.equal(r.message.status, "failed");
  assert.equal(r.message.nextRetryAt, null);
  advance(100000);
  assert.equal(await integ.retryDue(), 0);
  await clinic.close();
});

test("credenciales malas: falla sin reintento automático y con mensaje claro", async () => {
  await seed({ clientSecret: encryptSecret("incorrecto") });
  const r = await integ.pushReport("t1", "r1");
  assert.equal(r.message.status, "failed");
  assert.match(r.message.lastError, /OAuth2.*credenciales inválidas/);
  assert.equal(r.message.nextRetryAt, null);
  await clinic.close();
});

test("destino caído (sin red): se reintenta", async () => {
  await seed();
  await clinic.close();
  const r = await integ.pushReport("t1", "r1");
  assert.equal(r.message.status, "failed");
  assert.ok(r.message.nextRetryAt, "red caída es transitorio");
  assert.match(r.message.lastError, /No se pudo conectar/);
});

test("no duplica: publicar dos veces la misma versión crea un solo envío; force reenvía", async () => {
  await seed();
  await integ.pushReport("t1", "r1");
  const again = await integ.pushReport("t1", "r1");
  assert.ok(again.skipped);
  assert.equal(msgs().length, 1);
  const forced = await integ.pushReport("t1", "r1", { force: true });
  assert.equal(forced.message.status, "acknowledged");
  assert.equal(msgs().length, 2);
  assert.equal(clinic.state.received.length, 2);
  assert.equal(clinic.state.received[0].key, clinic.state.received[1].key, "misma Idempotency-Key para que el destino deduplique");
  await clinic.close();
});

test("un informe en corrección ('amended') o en borrador NO se envía", async () => {
  await seed();
  await db.diagnosticReport.update({ where: { id: "r1" }, data: { status: "amended", version: 2 } });
  assert.ok((await integ.pushReport("t1", "r1")).skipped);
  await db.diagnosticReport.update({ where: { id: "r1" }, data: { status: "draft" } });
  assert.ok((await integ.pushReport("t1", "r1")).skipped);
  assert.equal(clinic.state.received.length, 0);
  await clinic.close();
});

test("un mensaje fallido de una versión vieja no se reenvía con el contenido de la nueva", async () => {
  await seed();
  clinic.state.failNext = 1;
  await integ.pushReport("t1", "r1"); // v1 falla
  await db.diagnosticReport.update({ where: { id: "r1" }, data: { version: 2 } });
  advance(2);
  await integ.retryDue();
  assert.equal(msgs()[0].status, "failed");
  assert.match(msgs()[0].lastError, /versión más reciente/);
  assert.equal(clinic.state.received.length, 0);
  await clinic.close();
});

test("conexión sin destino de retorno o desactivada: queda registrado como 'No enviado' y no toca la red", async () => {
  await seed({ baseUrl: null });
  const a = await integ.pushReport("t1", "r1");
  assert.equal(a.message.status, "skipped");
  assert.match(a.message.payloadSummary, /NO enviado: .*no tiene configurado el destino/);
  await clinic.close();

  await seed({ enabled: false });
  const b = await integ.pushReport("t1", "r1");
  assert.equal(b.message.status, "skipped");
  assert.match(b.message.payloadSummary, /desactivada/);
  assert.equal(clinic.state.tokenRequests.length + clinic.state.received.length, 0);
  await clinic.close();
});

test("una orden creada dentro del laboratorio (sin clínica) no genera ningún envío ni mensaje", async () => {
  await seed();
  await db.order.update({ where: { id: "o1" }, data: { connectionId: null } });
  const r = await integ.pushReport("t1", "r1");
  assert.ok(r.skipped && !r.message);
  assert.equal(msgs().length, 0);
  await clinic.close();
});

test("modo clave de API: manda 'Authorization: Bearer <clave>' y el FHIR completo, sin pedir token", async () => {
  await seed({ authType: "apikey", apiKey: encryptSecret("clave-fija") });
  let seenAuth = null, seenBody = null;
  const realFetch = globalThis.fetch;
  integ = createIntegration({ db, now, log: quiet, fetchImpl: async (url, opts) => { seenAuth = opts.headers.Authorization; seenBody = JSON.parse(opts.body); return new Response("{}", { status: 200 }); } });
  const r = await integ.pushReport("t1", "r1");
  assert.equal(r.message.status, "acknowledged");
  assert.equal(seenAuth, "Bearer clave-fija");
  assert.ok(seenBody.contained, "perfil full por defecto");
  assert.equal(clinic.state.tokenRequests.length, 0);
  assert.equal(realFetch, globalThis.fetch);
  await clinic.close();
});

test("mensajes colgados (el servidor se reinició a mitad del envío) se rescatan", async () => {
  await seed();
  await db.integrationMessage.create({ data: { tenantId: "t1", type: "ReportPublished", direction: "outbound", source: "DX", destination: "C", connectionId: "c1", status: "retrying", entityType: "DiagnosticReport", entityId: "r1", eventId: "report:r1:v1" } });
  advance(30);
  await integ.retryDue();
  assert.equal(msgs()[0].status, "acknowledged");
  await clinic.close();
});

test("probar conexión: informa cada paso y detecta credenciales malas", async () => {
  await seed();
  const ok = await integ.testConnection("t1", "c1");
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.steps.map((s) => s.step), ["Configuración", "Token OAuth2", "Servidor FHIR (/metadata)"]);
  assert.equal(clinic.state.received.length, 0, "no envía datos clínicos");
  await clinic.close();

  await seed({ clientSecret: encryptSecret("mal") });
  const bad = await integ.testConnection("t1", "c1");
  assert.equal(bad.ok, false);
  assert.equal(bad.steps.at(-1).step, "Token OAuth2");
  await clinic.close();
});
