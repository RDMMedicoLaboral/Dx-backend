import "dotenv/config";
import { runSeed } from "../src/lib/seedLogic.js";
import { prisma } from "../src/lib/prisma.js";

runSeed()
  .then((creds) => {
    console.log("Seed completo:");
    console.log("  Superadmin:  ", creds.superadmin);
    console.log("  Dueño (Lab): ", creds.duenoLab);
    console.log("  Dueño (Img): ", creds.duenoImg);
  })
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
