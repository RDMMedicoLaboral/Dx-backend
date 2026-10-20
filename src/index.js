import "dotenv/config";
import "./lib/asyncErrors.js"; // debe ir antes de crear rutas
import express from "express";
import cors from "cors";
import morgan from "morgan";

import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import clinicalRoutes from "./routes/clinical.js";
import fhirRoutes from "./routes/fhir.js";
import publicRoutes from "./routes/public.js";
import uploadRoutes from "./routes/uploads.js";
import stateRoutes from "./routes/state.js";
import catalogImportRoutes from "./routes/catalogImport.js";
import { startRetryWorker } from "./lib/integration.js";
import { runStartupSecurity } from "./lib/bootstrap.js";
import { fhirJsonParser } from "./lib/bodyParsers.js";
import { migrateLegacyConnections, ensureOrderUniqueIndex } from "./lib/connections.js";
import { prisma } from "./lib/prisma.js";

if (!process.env.JWT_SECRET) {
  console.error("Falta JWT_SECRET: sin él no se pueden firmar sesiones ni cifrar los secretos de integración.");
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1); // detrás del proxy de Render: así req.ip es la IP real del visitante (límite de intentos de login)

const allowedOrigins = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true, // en desarrollo, permite cualquier origen
  credentials: false,
}));
app.use("/api/fhir", fhirJsonParser); // la API FHIR acepta application/fhir+json, application/json o sin tipo
app.use(express.json({ limit: "2mb" }));
app.use(morgan("tiny"));

app.get("/", (_req, res) => res.json({ ok: true, service: "diagnostic-os-backend" }));
// "features" sirve para comprobar de un vistazo QUÉ versión está corriendo realmente en el servidor
// (abre https://tu-backend.onrender.com/health en el navegador).
app.get("/health", (_req, res) => res.json({ ok: true, version: "2026-10-19", features: ["connections-per-clinic", "oauth2-outbound", "secure-admin-bootstrap"] }));

// El orden importa: como clinicalRoutes se monta en el prefijo genérico "/api",
// tiene que ir DESPUÉS de todas las rutas más específicas (/api/auth,
// /api/admin, /api/fhir, /api/public, /api/uploads) — si no, su
// middleware de autenticación intercepta cualquier request que empiece con
// "/api/..." antes de que le toque el turno a las demás.
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
// Si una ruta de administrador no existe (p. ej. el servidor quedó con una versión vieja), responder 404 claro
// en lugar de dejar que la petición caiga en las rutas de centros y devuelva un error engañoso.
app.use("/api/admin", (_req, res) => res.status(404).json({ error: "Ruta no encontrada en el servidor. Si acabas de actualizar, el backend puede no haberse desplegado todavía (revisa /health)." }));
app.use("/api/fhir", fhirRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/state", stateRoutes);
app.use("/api/catalog-import", catalogImportRoutes);
app.use("/api", clinicalRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Error interno del servidor" });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Diagnostic OS backend escuchando en el puerto ${port}`);
  startRetryWorker(); // reintenta solo los envíos fallidos hacia el sistema conectado
  runStartupSecurity({ db: prisma }); // crea/actualiza el admin desde ADMIN_EMAIL/ADMIN_PASSWORD y avisa de contraseñas públicas
  ensureOrderUniqueIndex(prisma);
  migrateLegacyConnections(prisma).catch((err) => console.error("[conexiones] No se pudo migrar la configuración anterior:", err.message)); // un conector por centro -> una conexión por clínica
});
