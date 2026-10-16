import { reportToDiagnosticReport } from "./fhir.js";
import { buildClinicOsReport } from "./clinicosReport.js";
import { loadReportContext } from "./reportContext.js";
import { createTokenProvider, fetchWithTimeout } from "./oauthClient.js";
import { decryptSecret } from "./secrets.js";

// ---------------------------------------------------------------------------------
// Envío de informes publicados hacia el sistema externo (HCE / Clinic-OS).
//
// Garantías:
//  - Cada envío queda registrado como IntegrationMessage (visible en el panel), salga bien o mal.
//  - Si falla por algo transitorio (red caída, 5xx, 429, timeout) se reintenta solo, con espera
//    creciente: 1 min, 5, 15, 1 h, 4 h (máx. 6 intentos). Si falla por algo permanente (400, 403,
//    404, 422, credenciales malas) NO se reintenta solo: queda en "failed" a la espera de que
//    alguien corrija la configuración y pulse "Reintentar".
//  - El mismo informe + versión nunca se envía dos veces en paralelo (eventId + reclamo atómico).
//  - El receptor puede deduplicar: cada POST lleva Idempotency-Key = "<reportId>:v<version>" y
//    el recurso trae identifier + meta.versionId.
//
// Se construye con "inyección de dependencias" (db, fetch, reloj) para poder probarlo sin base
// de datos real ni red. La instancia real está en integration.js.
// ---------------------------------------------------------------------------------

export const MAX_ATTEMPTS = 6;
const BACKOFF_MINUTES = [1, 5, 15, 60, 240];
// Solo se envía lo PUBLICADO. Un informe "amended" es uno que se está corrigiendo (aún sin republicar):
// mandarlo ahora enviaría el contenido viejo como si fuera el corregido.
const SENDABLE = ["published"];

const trimSlash = (u) => String(u || "").replace(/\/+$/, "");

export function createIntegration({ db, fetchImpl = globalThis.fetch, now = () => new Date(), tokenProvider, log = console, profileOverride } = {}) {
  const tokens = tokenProvider || createTokenProvider({ fetchImpl, now: () => now().getTime() });

  function connectorOf(tenant) {
    const baseUrl = trimSlash(tenant?.thirdPartyBaseUrl);
    const authType = tenant?.thirdPartyAuthType === "oauth2" ? "oauth2" : "apikey";
    return {
      baseUrl,
      authType,
      apiKey: decryptSecret(tenant?.thirdPartyApiKey),
      tokenUrl: tenant?.thirdPartyTokenUrl ? tenant.thirdPartyTokenUrl : baseUrl ? `${baseUrl}/oauth/token` : "",
      clientId: tenant?.thirdPartyClientId || "",
      clientSecret: decryptSecret(tenant?.thirdPartyClientSecret) || "",
      scope: tenant?.thirdPartyScope || "system/DiagnosticReport.write",
      name: tenant?.thirdPartyName || "Conector de terceros",
    };
  }

  // Perfil del contenido que se envía:
  //  "clinicos" -> lo que Clinic-Os sabe recibir (cédula + orden original + texto del resultado).
  //                Es el predeterminado cuando el conector usa OAuth2.
  //  "full"     -> FHIR completo y autocontenido (Observations, adjuntos). Predeterminado con clave de API.
  // Se puede forzar con la variable INTEGRATION_PAYLOAD_PROFILE=full|clinicos.
  function profileOf(cfg) {
    const forced = profileOverride || process.env.INTEGRATION_PAYLOAD_PROFILE;
    if (forced === "full" || forced === "clinicos") return forced;
    return cfg.authType === "oauth2" ? "clinicos" : "full";
  }

  async function authHeader(tenantId, cfg, { forceRefresh = false } = {}) {
    if (cfg.authType === "oauth2") {
      const token = await tokens.getToken({ cacheKey: tenantId, tokenUrl: cfg.tokenUrl, clientId: cfg.clientId, clientSecret: cfg.clientSecret, scope: cfg.scope }, { forceRefresh });
      return { Authorization: `Bearer ${token}` };
    }
    return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
  }

  const backoffAt = (attempts) => new Date(now().getTime() + BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)] * 60000);

  /** Hace el POST y devuelve { status: "acknowledged"|"duplicate"|"failed", retryable, detail }. */
  async function deliver(tenant, report) {
    const cfg = connectorOf(tenant);
    const ctx = await loadReportContext(db, report);
    let payload;
    if (profileOf(cfg) === "clinicos") {
      const built = buildClinicOsReport({ tenant, report, order: ctx.order, study: ctx.study, patient: ctx.patient, results: ctx.results });
      if (built.skip) return { status: "skipped", detail: built.skip };
      payload = built.payload;
    } else {
      payload = reportToDiagnosticReport(report, ctx.order, ctx.study, ctx);
    }
    const url = `${cfg.baseUrl}/DiagnosticReport`;
    const baseHeaders = {
      "Content-Type": "application/fhir+json",
      Accept: "application/fhir+json",
      "Idempotency-Key": `${report.id}:v${report.version || 1}`,
    };

    const post = async (forceRefresh) => fetchWithTimeout(fetchImpl, url, {
      method: "POST",
      headers: { ...baseHeaders, ...(await authHeader(tenant.id, cfg, { forceRefresh })) },
      body: JSON.stringify(payload),
    });

    let res = await post(false);
    if (res.status === 401 && cfg.authType === "oauth2") { // el token pudo vencer/revocarse: pide uno nuevo una vez
      tokens.invalidate(tenant.id);
      res = await post(true);
    }

    if (res.ok) return { status: "acknowledged", detail: `HTTP ${res.status}` };
    if (res.status === 409) return { status: "duplicate", detail: "HTTP 409 (el destino ya tenía esta versión)" };

    // Mensaje útil del destino: primero el "diagnostics" del OperationOutcome, si no el texto crudo.
    let body = "";
    try {
      const raw = await res.text();
      let parsed = null; try { parsed = JSON.parse(raw); } catch { /* no es JSON */ }
      body = String(parsed?.issue?.[0]?.diagnostics || parsed?.error_description || parsed?.error || raw || "").slice(0, 300);
    } catch { /* sin cuerpo */ }
    const retryable = res.status >= 500 || [408, 425, 429].includes(res.status);
    return { status: "failed", retryable, detail: `HTTP ${res.status}${body ? ` — ${body.replace(/\s+/g, " ")}` : ""}` };
  }

  /** Ejecuta un intento sobre un mensaje ya existente y deja el resultado registrado. */
  async function attempt(message, tenant, report, attempts) {
    let outcome;
    try {
      outcome = await deliver(tenant, report);
    } catch (err) {
      outcome = { status: "failed", retryable: err.retryable !== false, detail: err.message };
    }

    const failed = outcome.status === "failed";
    const skipped = outcome.status === "skipped"; // no tenía sentido enviarlo (p. ej. orden que no vino de Clinic-Os)
    const prefix = skipped ? "NO enviado: " : "";
    const summary = `DiagnosticReport/${report.id} v${report.version || 1} → ${trimSlash(tenant.thirdPartyBaseUrl)} — ${prefix}${outcome.detail}`.slice(0, 500);
    const canRetry = failed && outcome.retryable && attempts < MAX_ATTEMPTS;
    return db.integrationMessage.update({
      where: { id: message.id },
      data: {
        status: outcome.status,
        attempts,
        payloadSummary: summary,
        lastError: failed ? outcome.detail.slice(0, 500) : null,
        nextRetryAt: canRetry ? backoffAt(attempts) : null,
      },
    });
  }

  /**
   * Envía (o encola) un informe publicado. Nunca lanza: los errores quedan en el mensaje.
   * opts.force = true → crea un envío nuevo aunque ya haya uno exitoso (reenvío manual).
   */
  async function pushReport(tenantId, reportId, opts = {}) {
    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant?.thirdPartyBaseUrl) return { skipped: "El centro no tiene conector configurado." };

    const report = await db.diagnosticReport.findFirst({ where: { id: reportId, tenantId } });
    if (!report) return { skipped: "Informe no encontrado." };
    if (!SENDABLE.includes(report.status)) return { skipped: "El informe todavía no está publicado." };

    const eventId = `report:${report.id}:v${report.version || 1}`;
    const existing = await db.integrationMessage.findFirst({ where: { tenantId, direction: "outbound", entityType: "DiagnosticReport", entityId: report.id, eventId }, orderBy: { createdAt: "desc" } });
    if (existing && !opts.force) return { skipped: `Ya existe un envío de esta versión (${existing.status}).`, message: existing };
    if (existing && opts.force && existing.status === "failed") return retryMessage(existing.id, { manual: true });
    if (existing && ["pending", "retrying"].includes(existing.status)) return { skipped: "Ya hay un envío en curso.", message: existing };

    const message = await db.integrationMessage.create({
      data: {
        tenantId, type: "ReportPublished", direction: "outbound", source: "Diagnostic OS", destination: tenant.thirdPartyName || "Conector de terceros",
        status: "pending", attempts: 1, entityType: "DiagnosticReport", entityId: report.id,
        eventId: existing ? `${eventId}:r${now().getTime()}` : eventId,
        payloadSummary: `DiagnosticReport/${report.id} v${report.version || 1} → ${trimSlash(tenant.thirdPartyBaseUrl)}`,
      },
    });
    const updated = await attempt(message, tenant, report, 1);
    return { message: updated };
  }

  /** Reintenta un mensaje fallido. manual=true ignora el tope de intentos y la espera. */
  async function retryMessage(messageId, { manual = false } = {}) {
    // Reclamo atómico: solo uno gana, aunque el reintento automático y un clic manual coincidan.
    const claimed = await db.integrationMessage.updateMany({ where: { id: messageId, status: "failed", direction: "outbound" }, data: { status: "retrying" } });
    if (!claimed.count) return { skipped: "El mensaje no está en estado 'failed' (ya se reintentó o ya fue entregado)." };

    const message = await db.integrationMessage.findUnique({ where: { id: messageId } });
    const give = (reason) => db.integrationMessage.update({ where: { id: messageId }, data: { status: "failed", lastError: reason, nextRetryAt: null, payloadSummary: `${message.payloadSummary} — ${reason}`.slice(0, 500) } }).then((m) => ({ message: m }));

    const tenant = await db.tenant.findUnique({ where: { id: message.tenantId } });
    if (!tenant?.thirdPartyBaseUrl) return give("El centro ya no tiene conector configurado.");
    const report = message.entityId ? await db.diagnosticReport.findFirst({ where: { id: message.entityId, tenantId: message.tenantId } }) : null;
    if (!report) return give("El informe ya no existe.");
    if (!SENDABLE.includes(report.status)) return give("El informe ya no está publicado.");
    // Si el informe se corrigió y republicó, este mensaje es de una versión vieja: la nueva tiene su propio envío.
    if ((message.eventId || "").split(":")[2] !== `v${report.version || 1}`) return give("Superado por una versión más reciente del informe.");

    const attempts = (message.attempts || 1) + 1;
    const updated = await attempt(message, tenant, report, attempts);
    // Un reintento manual que vuelve a fallar con causa transitoria queda programado de nuevo.
    if (manual && updated.status === "failed" && !updated.nextRetryAt && attempts >= MAX_ATTEMPTS) log.warn?.(`[integración] ${messageId} agotó los reintentos automáticos`);
    return { message: updated };
  }

  /** Lo llama el temporizador: reintenta lo vencido y rescata mensajes que quedaron "colgados". */
  async function retryDue() {
    const stuckBefore = new Date(now().getTime() - 10 * 60000);
    await db.integrationMessage.updateMany({
      where: { direction: "outbound", status: { in: ["pending", "retrying"] }, updatedAt: { lt: stuckBefore } },
      data: { status: "failed", nextRetryAt: now(), lastError: "El envío quedó interrumpido (reinicio del servidor); se reintentará." },
    });
    const due = await db.integrationMessage.findMany({
      where: { direction: "outbound", status: "failed", entityType: "DiagnosticReport", nextRetryAt: { lte: now() } },
      orderBy: { nextRetryAt: "asc" }, take: 20,
    });
    let done = 0;
    for (const m of due) {
      try { await retryMessage(m.id); done += 1; } catch (err) { log.error?.("[integración] error reintentando", m.id, err.message); }
    }
    return done;
  }

  /** Verifica la conexión paso a paso, sin enviar ningún dato clínico. */
  async function testConnection(tenantId) {
    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    const steps = [];
    const add = (step, ok, detail, warning = false) => steps.push({ step, ok, detail, ...(warning ? { warning: true } : {}) });
    const cfg = connectorOf(tenant);

    if (!cfg.baseUrl) { add("Configuración", false, "Falta la URL base del sistema externo."); return { ok: false, steps }; }
    add("Configuración", true, `${cfg.name} · ${cfg.baseUrl} · autenticación ${cfg.authType === "oauth2" ? "OAuth2 client_credentials" : "clave de API"}`);

    let headers = {};
    try {
      headers = await authHeader(tenantId, cfg, { forceRefresh: true });
      add(cfg.authType === "oauth2" ? "Token OAuth2" : "Credencial", Boolean(headers.Authorization), cfg.authType === "oauth2" ? `Token obtenido (scope solicitado: ${cfg.scope})` : headers.Authorization ? "Clave de API presente" : "No hay clave configurada (se enviará sin autenticación)", !headers.Authorization);
    } catch (err) {
      add("Token OAuth2", false, err.message);
      return { ok: false, steps };
    }

    try {
      const res = await fetchWithTimeout(fetchImpl, `${cfg.baseUrl}/metadata`, { headers: { Accept: "application/fhir+json", ...headers } }, 10000);
      if (res.ok) {
        let version = ""; try { version = (await res.json())?.fhirVersion || ""; } catch { /* sin JSON */ }
        add("Servidor FHIR (/metadata)", true, `Responde${version ? ` · FHIR ${version}` : ""}`);
      } else add("Servidor FHIR (/metadata)", false, `HTTP ${res.status}`, res.status === 404);
    } catch (err) { add("Servidor FHIR (/metadata)", false, err.message); }

    return { ok: steps.every((s) => s.ok || s.warning), steps };
  }

  return { pushReport, retryMessage, retryDue, testConnection, connectorOf };
}
