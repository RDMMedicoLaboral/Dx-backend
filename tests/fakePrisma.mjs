// Sustituye a src/lib/prisma.js durante las pruebas (ver hooks.mjs).
import { makeDb } from "./fakeDb.mjs";
export const prisma = globalThis.__testDb || (globalThis.__testDb = makeDb());
