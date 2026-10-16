// Un "Clinic-OS" de mentira con el contrato que describe su documento: OAuth2 client_credentials
// (token de 15 min, scope concreto) + POST /DiagnosticReport + GET /metadata. Se puede romper a voluntad.
import http from "node:http";
import crypto from "node:crypto";

export async function startFakeClinicOs({ clientId = "dx-client", clientSecret = "s3cret", authStyle = "json" } = {}) {
  const state = {
    tokens: new Map(), received: [], tokenRequests: [], failNext: 0, failStatus: 503, expireAll: false, ttl: 900,
  };
  const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
  const json = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/api/fhir/metadata") return json(res, 200, { resourceType: "CapabilityStatement", fhirVersion: "4.0.1" });

    if (req.method === "POST" && url.pathname === "/api/fhir/oauth/token") {
      const raw = await readBody(req);
      const ctype = req.headers["content-type"] || "";
      const basic = req.headers.authorization?.startsWith("Basic ");
      const mode = basic ? "basic" : ctype.includes("json") ? "json" : "form";
      let p = {};
      if (mode === "json") { try { p = JSON.parse(raw); } catch { /* vacío */ } }
      else { const q = new URLSearchParams(raw); p = Object.fromEntries(q.entries()); }
      let id = p.client_id, secret = p.client_secret;
      if (basic) [id, secret] = Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":").map(decodeURIComponent);
      state.tokenRequests.push({ mode, scope: p.scope, grant: p.grant_type });
      if (mode !== authStyle) return json(res, 401, { error: "invalid_client" }); // este servidor solo entiende una forma
      if (p.grant_type !== "client_credentials" || id !== clientId || secret !== clientSecret) return json(res, 401, { error: "invalid_client", error_description: "credenciales inválidas" });
      const token = crypto.randomBytes(12).toString("hex");
      state.tokens.set(token, { scope: p.scope });
      return json(res, 200, { access_token: token, token_type: "Bearer", expires_in: state.ttl, scope: p.scope });
    }

    if (req.method === "POST" && url.pathname === "/api/fhir/DiagnosticReport") {
      const token = (req.headers.authorization || "").replace("Bearer ", "");
      if (state.expireAll) { state.tokens.clear(); state.expireAll = false; }
      const t = state.tokens.get(token);
      if (!t) return json(res, 401, { error: "invalid_token" });
      if (!t.scope?.includes("system/DiagnosticReport.write")) return json(res, 403, { error: "insufficient_scope" });
      const body = JSON.parse(await readBody(req));
      if (state.failNext > 0) { state.failNext--; return json(res, state.failStatus, { resourceType: "OperationOutcome", issue: [{ severity: "error", code: "exception", diagnostics: "fallo simulado" }] }); }
      const key = req.headers["idempotency-key"];
      const dup = state.received.find((r) => r.key === key);
      state.received.push({ key, body, contentType: req.headers["content-type"] });
      return json(res, dup ? 200 : 201, { resourceType: "OperationOutcome", issue: [{ severity: "information", code: "informational", diagnostics: "ok" }] });
    }
    json(res, 404, { error: "no existe" });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { state, baseUrl: `http://127.0.0.1:${port}/api/fhir`, clientId, clientSecret, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
