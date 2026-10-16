// Express 4 no captura los errores de handlers async: un fallo de base de datos dejaba la
// petición colgada o, en Node moderno, tumbaba todo el servicio por "unhandledRejection".
// Este parche (la misma técnica del paquete express-async-errors) manda esos errores al
// manejador de errores de Express. Debe importarse ANTES de crear cualquier ruta.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Layer = require("express/lib/router/layer");

Layer.prototype.handle_request = function patchedHandleRequest(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return next(); // es un manejador de errores: no se toca
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === "function") out.catch(next);
  } catch (err) {
    next(err);
  }
};
