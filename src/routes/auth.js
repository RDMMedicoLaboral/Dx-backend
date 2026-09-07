import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { signToken } from "../middleware/auth.js";

const router = Router();

function publicUser(u) {
  return { id: u.id, tenantId: u.tenantId, name: u.name, email: u.email, role: u.role };
}

// Login para dueños de centro y su personal. Nunca deja entrar a platform_admin
// aquí — esa cuenta solo puede autenticarse por /api/auth/admin-login.
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Correo y contraseña son obligatorios" });

  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user || user.role === "platform_admin") return res.status(401).json({ error: "Correo o contraseña incorrectos" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Correo o contraseña incorrectos" });

  res.json({ token: signToken(user), user: publicUser(user) });
});

// Login exclusivo del panel de superadmin (admin.html / diagnostic-os-admin.html).
router.post("/admin-login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Correo y contraseña son obligatorios" });

  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user || user.role !== "platform_admin") {
    return res.status(401).json({ error: "Correo o contraseña incorrectos, o esta cuenta no es de administrador de plataforma" });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Correo o contraseña incorrectos" });

  res.json({ token: signToken(user), user: publicUser(user) });
});

export default router;
