import { prisma } from "./prisma.js";
import { createIntegration } from "./integrationCore.js";

// Instancia real (con la base de datos de verdad). La lógica está en integrationCore.js.
const integration = createIntegration({ db: prisma });

export const pushReportToConnector = (tenantId, reportId, opts) => integration.pushReport(tenantId, reportId, opts);
export const retryIntegrationMessage = (messageId, opts) => integration.retryMessage(messageId, opts);
export const testConnector = (tenantId, connectionId) => integration.testConnection(tenantId, connectionId);

// Reintento automático de envíos fallidos. En el plan gratuito de Render el servicio se duerme
// tras 15 min sin tráfico: al despertar, este temporizador retoma lo pendiente.
let timer = null;
export function startRetryWorker({ everyMs = 60000 } = {}) {
  if (timer) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await integration.retryDue(); } catch (err) { console.error("[integración] fallo en el ciclo de reintentos:", err.message); } finally { running = false; }
  };
  timer = setInterval(tick, everyMs);
  timer.unref?.();
  setTimeout(tick, 5000).unref?.(); // un primer barrido poco después de arrancar
}
