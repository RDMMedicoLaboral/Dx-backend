import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";

import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import clinicalRoutes from "./routes/clinical.js";
import fhirRoutes from "./routes/fhir.js";
import publicRoutes from "./routes/public.js";
import uploadRoutes from "./routes/uploads.js";
import devRoutes from "./routes/dev.js";
import stateRoutes from "./routes/state.js";

const app = express();

const allowedOrigins = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true, // en desarrollo, permite cualquier origen
  credentials: false,
}));
app.use(express.json({ limit: "2mb" }));
app.use(morgan("tiny"));

app.get("/", (_req, res) => res.json({ ok: true, service: "diagnostic-os-backend" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// El orden importa: como clinicalRoutes se monta en el prefijo genérico "/api",
// tiene que ir DESPUÉS de todas las rutas más específicas (/api/auth,
// /api/admin, /api/fhir, /api/public, /api/uploads, /api/dev) — si no, su
// middleware de autenticación intercepta cualquier request que empiece con
// "/api/..." antes de que le toque el turno a las demás.
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/fhir", fhirRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/dev", devRoutes);
app.use("/api/state", stateRoutes);
app.use("/api", clinicalRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Error interno del servidor" });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Diagnostic OS backend escuchando en el puerto ${port}`));
