// Crea (o actualiza la contraseña de) el administrador de plataforma desde la consola:
//   ADMIN_EMAIL=tu@correo.com ADMIN_PASSWORD='una-clave-larga' npm run create-admin
// En Render no hace falta: basta con definir ADMIN_EMAIL y ADMIN_PASSWORD en Environment; el
// servidor lo hace solo al arrancar.
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { ensurePlatformAdmin } from "../src/lib/bootstrap.js";

ensurePlatformAdmin({ db: prisma, email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, name: process.env.ADMIN_NAME })
  .then((r) => { console.log(`Administrador: ${r.status}${r.reason ? ` — ${r.reason}` : ""}`); process.exitCode = ["created", "updated", "unchanged"].includes(r.status) ? 0 : 1; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
