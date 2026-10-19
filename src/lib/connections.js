import { decryptSecret, sha256Hex } from "./secrets.js";

// ---------------------------------------------------------------------------------
// Conexiones: una por cada pareja "este laboratorio ⇄ una clínica / sistema externo".
//
// Por qué existen: antes cada centro tenía UN solo conector y UNA sola clave. Si dos clínicas le
// enviaban órdenes al mismo laboratorio, sus órdenes se mezclaban (la "5" de una era la "5" de la
// otra) y los resultados no sabían a cuál volver. Ahora:
//   - cada clínica tiene su propia clave de entrada → el laboratorio sabe con certeza quién envía;
//   - cada orden queda marcada con su conexión de origen (order.connectionId);
//   - el informe de una orden se devuelve SOLO a la conexión de esa orden, nunca a otra.
// ---------------------------------------------------------------------------------

const trimSlash = (u) => String(u || "").replace(/\/+$/, "");

/** Forma segura de una conexión para el navegador: jamás lleva secretos, solo si existen. */
export function connectionPublic(c, extra = {}) {
  return {
    id: c.id, tenantId: c.tenantId, name: c.name, type: c.type, protocol: c.protocol, enabled: c.enabled !== false,
    baseUrl: c.baseUrl || "", authType: c.authType || "oauth2", tokenUrl: c.tokenUrl || "", clientId: c.clientId || "",
    scope: c.scope || "system/DiagnosticReport.write",
    apiKeySet: Boolean(c.apiKey), clientSecretSet: Boolean(c.clientSecret), inboundKeySet: Boolean(c.inboundKeyHash),
    inboundKeyCreatedAt: c.inboundKeyCreatedAt || null, createdAt: c.createdAt,
    ...extra,
  };
}

/** Configuración de salida ya lista para usar (secretos descifrados). */
export function connectionConfig(c) {
  const baseUrl = trimSlash(c?.baseUrl);
  return {
    id: c?.id,
    name: c?.name || "Sistema externo",
    baseUrl,
    authType: c?.authType === "apikey" ? "apikey" : "oauth2",
    apiKey: decryptSecret(c?.apiKey),
    tokenUrl: c?.tokenUrl ? c.tokenUrl : baseUrl ? `${baseUrl}/oauth/token` : "",
    clientId: c?.clientId || "",
    clientSecret: decryptSecret(c?.clientSecret) || "",
    scope: c?.scope || "system/DiagnosticReport.write",
  };
}

const MESSAGE_TYPES = ["ReportPublished", "ServiceRequestReceived", "ServiceRequestCancelled"];

/**
 * Migra la configuración antigua (un solo conector por centro, guardada en el propio Tenant) a una
 * Connection, conservando la clave de entrada (la clínica NO tiene que cambiar nada) y marcando las
 * órdenes y mensajes existentes con esa conexión. Es idempotente: después de migrar vacía los campos
 * antiguos, así que correrla otra vez no hace nada.
 */
export async function migrateLegacyConnections(db, { tenantId, log = console } = {}) {
  const tenants = await db.tenant.findMany({ where: tenantId ? { id: tenantId } : {} });
  let migrated = 0;
  for (const t of tenants) {
    const hasLegacy = t.thirdPartyBaseUrl || t.inboundKeyHash || t.thirdPartyApiKey || t.thirdPartyClientSecret || t.thirdPartyClientId;
    if (!hasLegacy) continue;

    const already = await db.connection.count({ where: { tenantId: t.id } });
    if (!already) {
      const legacyApiKey = decryptSecret(t.thirdPartyApiKey);
      const conn = await db.connection.create({
        data: {
          tenantId: t.id,
          name: t.thirdPartyName && t.thirdPartyName !== "Conector de terceros" ? t.thirdPartyName : "Conexión principal",
          type: t.thirdPartyType && !t.thirdPartyType.includes("/") ? t.thirdPartyType : "HCE",
          protocol: "FHIR R4",
          baseUrl: t.thirdPartyBaseUrl || null,
          authType: t.thirdPartyAuthType === "oauth2" ? "oauth2" : "apikey",
          tokenUrl: t.thirdPartyTokenUrl || null,
          clientId: t.thirdPartyClientId || null,
          clientSecret: t.thirdPartyClientSecret || null, // ya viene cifrado
          apiKey: t.thirdPartyApiKey || null,             // ya viene cifrado
          scope: t.thirdPartyScope || "system/DiagnosticReport.write",
          // La clave de entrada que ya usaba la clínica sigue valiendo: hash existente o, en centros muy
          // antiguos, el hash de la clave única que servía para los dos sentidos.
          inboundKeyHash: t.inboundKeyHash || (legacyApiKey ? sha256Hex(legacyApiKey) : null),
          inboundKeyCreatedAt: t.inboundKeyHash || legacyApiKey ? new Date() : null,
        },
      });
      await db.order.updateMany({ where: { tenantId: t.id, connectionId: null, sourceType: "HCE" }, data: { connectionId: conn.id } });
      await db.integrationMessage.updateMany({ where: { tenantId: t.id, connectionId: null, type: { in: MESSAGE_TYPES } }, data: { connectionId: conn.id } });
      // Los identificadores externos que ya tenían los pacientes eran de esa única clínica: se marcan con su conexión.
      const patients = await db.patient.findMany({ where: { tenantId: t.id } });
      for (const pt of patients) {
        const list = Array.isArray(pt.externalIdentifiers) ? pt.externalIdentifiers : [];
        if (list.some((e) => e && !e.connectionId)) {
          await db.patient.update({ where: { id: pt.id }, data: { externalIdentifiers: list.map((e) => (e && !e.connectionId ? { ...e, connectionId: conn.id } : e)) } });
        }
      }
      log.log?.(`[conexiones] Centro ${t.name}: configuración antigua migrada a la conexión "${conn.name}".`);
      migrated += 1;
    }
    // Los secretos antiguos ya no se usan: se vacían para que no queden duplicados ni "resuciten".
    await db.tenant.update({
      where: { id: t.id },
      data: { thirdPartyBaseUrl: null, thirdPartyApiKey: null, thirdPartyClientSecret: null, thirdPartyClientId: null, thirdPartyTokenUrl: null, inboundKeyHash: null, thirdPartyStatus: "No configurado" },
    });
  }
  return migrated;
}
