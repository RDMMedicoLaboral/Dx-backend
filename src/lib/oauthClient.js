// ---------------------------------------------------------------------------------
// Cliente OAuth2 "client_credentials" (RFC 6749 §4.4 / SMART Backend Services) para que
// Diagnostic OS pueda hablar con sistemas que, como Clinic-OS, exigen un token de corta
// duración en vez de una clave fija.
//
//  - Pide el token a tokenUrl y lo guarda en memoria hasta poco antes de que expire.
//  - Autenticación del cliente: prueba JSON, luego formulario, luego HTTP Basic, y recuerda
//    cuál funcionó. Así sirve con Clinic-Os (JSON) y con servidores OAuth2 "de libro".
// ---------------------------------------------------------------------------------

export async function fetchWithTimeout(fetchImpl, url, options = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchImpl(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (err?.name === "AbortError") throw Object.assign(new Error(`Tiempo de espera agotado (${ms / 1000}s) al conectar con ${new URL(url).host}`), { retryable: true });
    throw Object.assign(new Error(`No se pudo conectar con ${safeHost(url)}: ${err.cause?.code || err.message}`), { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

function safeHost(url) { try { return new URL(url).host; } catch { return url; } }

export function createTokenProvider({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const cache = new Map(); // clave = cacheKey (tenantId) -> { token, expiresAt, mode }

  // Formas de autenticar al cliente, en el orden en que se prueban la primera vez:
  //  json  -> POST application/json con client_id/client_secret (lo que acepta Clinic-Os)
  //  form  -> POST x-www-form-urlencoded (RFC 6749 §4.4, la forma "de libro")
  //  basic -> HTTP Basic con client_id:client_secret (RFC 6749 §2.3.1)
  const MODES = ["json", "form", "basic"];

  async function requestToken({ tokenUrl, clientId, clientSecret, scope }, mode) {
    const headers = { Accept: "application/json" };
    let body;
    if (mode === "json") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, ...(scope ? { scope } : {}) });
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const params = new URLSearchParams({ grant_type: "client_credentials", ...(scope ? { scope } : {}) });
      if (mode === "basic") headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
      else { params.set("client_id", clientId); params.set("client_secret", clientSecret); }
      body = params.toString();
    }
    return fetchWithTimeout(fetchImpl, tokenUrl, { method: "POST", headers, body });
  }

  async function readJson(res) { try { return await res.json(); } catch { return null; } }

  /** cfg = { cacheKey, tokenUrl, clientId, clientSecret, scope } */
  async function getToken(cfg, { forceRefresh = false } = {}) {
    if (!cfg.tokenUrl || !cfg.clientId || !cfg.clientSecret) {
      throw Object.assign(new Error("Faltan datos de OAuth2 (URL del token, client_id o client_secret)."), { retryable: false });
    }
    const cached = cache.get(cfg.cacheKey);
    if (!forceRefresh && cached && cached.expiresAt > now()) return cached.token;

    // Si ya sabemos qué forma funciona con este servidor, se usa solo esa. Si no, se prueban en
    // orden y SOLO se pasa a la siguiente cuando el rechazo parece de formato (400/415) o
    // "invalid_client" (puede ser que esperen otra forma de enviar el secreto).
    const known = cached?.mode;
    const modes = known ? [known] : MODES;
    let res, data, usedMode, firstWhy;
    for (const mode of modes) {
      res = await requestToken(cfg, mode);
      data = await readJson(res);
      usedMode = mode;
      if (res.ok && data?.access_token) break;
      // Se conserva el motivo más descriptivo que haya dado el servidor (el de la primera forma que lo explicó).
      firstWhy ||= data?.error_description;
      const formatProblem = [400, 415].includes(res.status) || (res.status === 401 && (data?.error === "invalid_client" || !data));
      if (!formatProblem) break;
    }

    if (!res.ok || !data?.access_token) {
      const why = firstWhy || data?.error_description || data?.error || `HTTP ${res.status}`;
      // 5xx / 429 del servidor de autorización: vale la pena reintentar; 4xx (credenciales malas): no.
      throw Object.assign(new Error(`OAuth2: el servidor rechazó la solicitud de token (${why}).`), { retryable: res.status >= 500 || res.status === 429, status: res.status });
    }
    const ttl = Math.max(10, (Number(data.expires_in) || 300) - 30); // margen de 30 s
    cache.set(cfg.cacheKey, { token: data.access_token, expiresAt: now() + ttl * 1000, mode: usedMode });
    return data.access_token;
  }

  const invalidate = (cacheKey) => { const c = cache.get(cacheKey); if (c) cache.set(cacheKey, { ...c, expiresAt: 0 }); }; // conserva el modo que funcionó
  return { getToken, invalidate };
}
