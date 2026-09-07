import { PrismaClient } from "@prisma/client";

// Evita crear múltiples conexiones en desarrollo con --watch.
const globalForPrisma = globalThis;
export const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
