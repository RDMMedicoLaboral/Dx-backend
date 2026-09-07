import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, tenantId: user.tenantId, role: user.role, name: user.name, email: user.email },
    SECRET,
    { expiresIn: "12h" }
  );
}

export function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Falta el token de sesión" });
  try {
    const payload = jwt.verify(token, SECRET);
    req.user = { id: payload.sub, tenantId: payload.tenantId, role: payload.role, name: payload.name, email: payload.email };
    next();
  } catch {
    return res.status(401).json({ error: "Sesión inválida o expirada" });
  }
}

// Para las rutas de un centro: nunca dejar pasar al superadmin por aquí (usa sus
// propias rutas /api/admin/*), y siempre fuerza el tenantId de la sesión, nunca
// el que venga en el body/query.
export function requireTenantUser(req, res, next) {
  if (!req.user || req.user.role === "platform_admin" || !req.user.tenantId) {
    return res.status(403).json({ error: "Esta ruta es solo para usuarios de un centro" });
  }
  next();
}

export function requirePlatformAdmin(req, res, next) {
  if (!req.user || req.user.role !== "platform_admin") {
    return res.status(403).json({ error: "Esta ruta es solo para el administrador de la plataforma" });
  }
  next();
}
