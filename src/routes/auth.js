import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { signToken } from "../middleware/auth.js";
import { createRateLimiter } from "../lib/rateLimit.js";

const router = Router();

// Máximo 8 intentos fallidos por IP + correo cada 15 minutos (un login correcto reinicia el contador).
const loginLimiter = createRateLimiter({ max: 8, windowMs: 15 * 60 * 1000 });
function throttled(req, res, email) {
  const key = `${req.ip}|${String(email || "").trim().toLowerCase()}`;
  const r = loginLimiter.attempt(key);
  if (!r.allowed) {
    res.set("Retry-After", String(r.retryAfterSec));
    res.status(429).json({ error: `Demasiados intentos. Espera ${Math.ceil(r.retryAfterSec / 60)} minuto(s) e inténtalo de nuevo.` });
    return null;
  }
  return key;
}

function publicUser(u) {
  return { id: u.id, tenantId: u.tenantId, name: u.name, email: u.email, role: u.role };
}

// Login para dueños de centro y su personal. Nunca deja entrar a platform_admin
// aquí — esa cuenta solo puede autenticarse por /api/auth/admin-login.
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Correo y contraseña son obligatorios" });
  const limitKey = throttled(req, res, email);
  if (!limitKey) return;

  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user || user.role === "platform_admin") return res.status(401).json({ error: "Correo o contraseña incorrectos" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Correo o contraseña incorrectos" });

  loginLimiter.reset(limitKey);
  res.json({ token: signToken(user), user: publicUser(user) });
});

// Login exclusivo del panel de superadmin (admin.html / diagnostic-os-admin.html).
router.post("/admin-login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Correo y contraseña son obligatorios" });
  const limitKey = throttled(req, res, email);
  if (!limitKey) return;

  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user || user.role !== "platform_admin") {
    return res.status(401).json({ error: "Correo o contraseña incorrectos, o esta cuenta no es de administrador de plataforma" });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Correo o contraseña incorrectos" });

  loginLimiter.reset(limitKey);
  res.json({ token: signToken(user), user: publicUser(user) });
});

export default router;
