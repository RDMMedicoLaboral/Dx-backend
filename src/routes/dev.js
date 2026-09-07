import { Router } from "express";
import { runSeed } from "../lib/seedLogic.js";

const router = Router();

// GET /api/dev/seed?key=TU_SEED_KEY
// Pensado para el plan gratuito de Render, que no da acceso a "Shell": en vez
// de correr `npm run seed` por consola, visitas esta URL una sola vez desde el
// navegador. Está protegida por SEED_KEY (variable de entorno) — sin la clave
// correcta, no hace nada. Es seguro correrla más de una vez (usa upsert).
router.get("/seed", async (req, res) => {
  if (!process.env.SEED_KEY) {
    return res.status(403).json({ error: "SEED_KEY no está configurada en el servidor. Agrégala en las variables de entorno de Render." });
  }
  if (req.query.key !== process.env.SEED_KEY) {
    return res.status(401).json({ error: "Clave incorrecta." });
  }
  try {
    const creds = await runSeed();
    res.json({ ok: true, message: "Datos de demostración cargados.", credenciales: creds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
