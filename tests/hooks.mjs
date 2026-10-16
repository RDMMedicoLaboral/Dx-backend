// Redirige cualquier import de ".../lib/prisma.js" al prisma falso.
export async function resolve(specifier, context, next) {
  if (/\/lib\/prisma\.js$|^\.\/prisma\.js$/.test(specifier) && context.parentURL?.includes("/src/")) {
    return { url: new URL("./fakePrisma.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
