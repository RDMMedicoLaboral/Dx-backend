import { prisma } from "./prisma.js";

export async function logAudit({ tenantId = null, userId = null, userName = "—", action, entityType, entityId = null, before = null, after = null }) {
  return prisma.auditEvent.create({
    data: { tenantId, userId, userName, action, entityType, entityId, before: before ?? undefined, after: after ?? undefined },
  });
}
