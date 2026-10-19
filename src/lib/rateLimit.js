// Limitador de intentos en memoria (ventana fija). Frena la adivinación de contraseñas por fuerza bruta.
// En memoria basta mientras el servicio corra en una sola instancia (el caso actual en Render).
export function createRateLimiter({ max = 8, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const hits = new Map(); // clave -> { count, resetAt }

  const sweep = () => { const t = now(); for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k); };

  return {
    /** Registra un intento; devuelve { allowed, retryAfterSec }. */
    attempt(key) {
      if (hits.size > 5000) sweep();
      const t = now();
      const cur = hits.get(key);
      if (!cur || cur.resetAt <= t) { hits.set(key, { count: 1, resetAt: t + windowMs }); return { allowed: true }; }
      cur.count += 1;
      if (cur.count > max) return { allowed: false, retryAfterSec: Math.ceil((cur.resetAt - t) / 1000) };
      return { allowed: true };
    },
    reset(key) { hits.delete(key); },
  };
}
