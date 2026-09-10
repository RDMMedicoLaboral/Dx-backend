import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { authenticate, requireTenantUser } from "../middleware/auth.js";
import { requirePermission, PERMISSIONS } from "../lib/permissions.js";

const router = Router();
router.use(authenticate, requireTenantUser);

const d = (v) => (v ? new Date(v) : null);
const j = (v, fallback) => (v === undefined ? fallback : v);

// Sincroniza una colección completa contra la base: crea lo nuevo, actualiza lo
// existente y borra lo que ya no esté en la lista que mandó el navegador — así
// la app puede seguir trabajando con arreglos en memoria, igual que antes con
// localStorage, pero ahora todo queda guardado en Postgres.
async function syncCollection(delegate, tenantId, items, buildData) {
  const incoming = Array.isArray(items) ? items : [];
  const existing = await delegate.findMany({ where: { tenantId }, select: { id: true } });
  const existingIds = new Set(existing.map((e) => e.id));
  const incomingIds = new Set(incoming.map((i) => i.id));
  const toDelete = [...existingIds].filter((id) => !incomingIds.has(id));
  if (toDelete.length) await delegate.deleteMany({ where: { id: { in: toDelete }, tenantId } });
  for (const item of incoming) {
    const data = buildData(item);
    await delegate.upsert({ where: { id: item.id }, create: { id: item.id, tenantId, ...data }, update: data });
  }
}

function publicUser(u) {
  return { id: u.id, tenantId: u.tenantId, name: u.name, email: u.email, role: u.role };
}

router.get("/", async (req, res) => {
  const tenantId = req.user.tenantId;
  const [tenant, users, patients, orders, studies, specimens, results, diagnosticReports, catalog, appointments, integrationMessages, auditEvents] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId } }),
    prisma.user.findMany({ where: { tenantId } }),
    prisma.patient.findMany({ where: { tenantId } }),
    prisma.order.findMany({ where: { tenantId } }),
    prisma.study.findMany({ where: { tenantId } }),
    prisma.specimen.findMany({ where: { tenantId } }),
    prisma.result.findMany({ where: { tenantId } }),
    prisma.diagnosticReport.findMany({ where: { tenantId } }),
    prisma.catalogItem.findMany({ where: { tenantId } }),
    prisma.appointment.findMany({ where: { tenantId }, orderBy: { scheduledAt: "asc" } }),
    prisma.integrationMessage.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } }),
    prisma.auditEvent.findMany({ where: { tenantId }, orderBy: { timestamp: "desc" }, take: 300 }),
  ]);

  const tenantOut = tenant ? { id: tenant.id, name: tenant.name, kind: tenant.kind, plan: tenant.plan, hours: { open: tenant.hoursOpen, close: tenant.hoursClose } } : null;

  res.json({
    tenant: tenantOut,
    users: users.map(publicUser),
    patients, orders, studies, specimens, results, diagnosticReports, catalog, appointments, integrationMessages, auditEvents,
  });
});

router.put("/", async (req, res) => {
  const tenantId = req.user.tenantId;
  const body = req.body || {};

  try {
    if (body.hours) {
      await prisma.tenant.update({ where: { id: tenantId }, data: { hoursOpen: body.hours.open, hoursClose: body.hours.close } });
    }

    if (body.users) {
      // El equipo del centro se sincroniza aquí, no en /api/admin (eso es solo
      // del superadmin). Nunca se permite crear un platform_admin desde aquí,
      // ni tocar la contraseña salvo que venga explícita (usuarios nuevos).
      if (!req.user.role || req.user.role === "platform_admin") throw Object.assign(new Error("No autorizado"), { status: 403 });
      const incoming = body.users.filter((u) => u.role !== "platform_admin");
      const existing = await prisma.user.findMany({ where: { tenantId }, select: { id: true } });
      const existingIds = new Set(existing.map((e) => e.id));
      const incomingIds = new Set(incoming.map((u) => u.id));
      const toDelete = [...existingIds].filter((id) => !incomingIds.has(id) && id !== req.user.id); // nunca te borras a ti mismo por accidente
      if (toDelete.length) await prisma.user.deleteMany({ where: { id: { in: toDelete }, tenantId } });
      for (const u of incoming) {
        const isNew = !existingIds.has(u.id);
        const data = { name: u.name, email: u.email?.trim().toLowerCase(), role: u.role };
        if (u.password) data.passwordHash = await bcrypt.hash(u.password, 10);
        if (isNew) {
          if (!u.password) continue; // un usuario nuevo necesita contraseña sí o sí
          await prisma.user.create({ data: { id: u.id, tenantId, ...data } });
        } else {
          await prisma.user.update({ where: { id: u.id }, data });
        }
      }
    }

    if (body.patients) {
      await syncCollection(prisma.patient, tenantId, body.patients, (p) => ({
        firstName: p.firstName, lastName: p.lastName, documentType: p.documentType || "cedula", documentNumber: p.documentNumber,
        birthDate: p.birthDate || null, sex: p.sex || null, externalIdentifiers: j(p.externalIdentifiers, []),
        sourceSystem: p.sourceSystem || null, sourcePatientId: p.sourcePatientId || null, matchStatus: p.matchStatus || "confirmado",
        createdAt: d(p.createdAt) || undefined,
      }));
    }

    if (body.orders) {
      await syncCollection(prisma.order, tenantId, body.orders, (o) => ({
        patientId: o.patientId, externalOrderId: o.externalOrderId || null, sourceSystem: o.sourceSystem || null,
        sourceType: o.sourceType || "interno", requestingPractitioner: j(o.requestingPractitioner, null),
        requestingOrganization: o.requestingOrganization || null, encounterId: o.encounterId || null, appointmentId: o.appointmentId || null,
        reason: o.reason || "", presumptiveDiagnosis: o.presumptiveDiagnosis || "", priority: o.priority || "rutina", notes: o.notes || "",
        status: o.status || "active", createdAt: d(o.createdAt) || undefined, scheduledAt: d(o.scheduledAt), receivedAt: d(o.receivedAt), completedAt: d(o.completedAt),
      }));
    }

    if (body.studies) {
      await syncCollection(prisma.study, tenantId, body.studies, (s) => ({
        orderId: s.orderId, patientId: s.patientId, serviceCode: s.serviceCode, serviceName: s.serviceName, modality: s.modality,
        status: s.status || "scheduled", room: s.room || "", equipment: s.equipment || "", technician: s.technician || "",
        scheduledAt: d(s.scheduledAt) || undefined, startedAt: d(s.startedAt), completedAt: d(s.completedAt),
        externalStudyId: s.externalStudyId || null, bodySite: s.bodySite || "", laterality: s.laterality || "", technique: s.technique || "",
        accessionNumber: s.accessionNumber || null, studyInstanceUID: s.studyInstanceUID || null, specimenId: s.specimenId || null, reportId: s.reportId || null,
      }));
    }

    if (body.specimens) {
      await syncCollection(prisma.specimen, tenantId, body.specimens, (sp) => ({
        studyId: sp.studyId, type: sp.type || "", status: sp.status || "pending", createdAt: d(sp.createdAt) || undefined,
        collectedAt: d(sp.collectedAt), receivedAt: d(sp.receivedAt), quality: sp.quality || null, rejectionReason: sp.rejectionReason || null,
      }));
    }

    if (body.results) {
      await syncCollection(prisma.result, tenantId, body.results, (r) => ({
        studyId: r.studyId, specimenId: r.specimenId || null, analyte: r.analyte, value: String(r.value ?? ""), unit: r.unit || "",
        referenceRange: r.referenceRange || "", flag: r.flag || "normal", method: r.method || "", status: r.status || "draft",
        critical: !!r.critical, criticalNotifiedAt: d(r.criticalNotifiedAt),
      }));
    }

    if (body.diagnosticReports) {
      await syncCollection(prisma.diagnosticReport, tenantId, body.diagnosticReports, (rep) => ({
        studyId: rep.studyId, orderId: rep.orderId, patientId: rep.patientId, type: rep.type, status: rep.status || "draft",
        authorId: rep.author?.userId || rep.authorId || null, authorName: rep.author?.name || rep.authorName || null,
        validatorId: rep.validator?.userId || rep.validatorId || null, validatorName: rep.validator?.name || rep.validatorName || null,
        conclusion: rep.conclusion || "", findings: rep.findings || "", impression: rep.impression || "",
        resultIds: j(rep.resultIds, []), version: rep.version || 1, amendmentReason: rep.amendmentReason || "", pdfRef: rep.pdfRef || null,
        createdAt: d(rep.createdAt) || undefined, validatedAt: d(rep.validatedAt), publishedAt: d(rep.publishedAt),
      }));
    }

    if (body.catalog) {
      await syncCollection(prisma.catalogItem, tenantId, body.catalog, (c) => ({
        code: c.code, name: c.name, modality: c.modality, price: Number(c.price) || 0, active: c.active !== false,
        preparation: c.preparation || "", estimatedTime: c.estimatedTime || "", externalCodes: j(c.externalCodes, []), reportTemplate: j(c.reportTemplate, {}),
      }));
    }

    if (body.appointments) {
      await syncCollection(prisma.appointment, tenantId, body.appointments, (a) => ({
        patientName: a.patientName, documentNumber: a.documentNumber || "", serviceCode: a.serviceCode, serviceName: a.serviceName,
        modality: a.modality, scheduledAt: d(a.scheduledAt) || new Date(), source: a.source || "Reserva en línea",
      }));
    }

    if (body.integrationMessages) {
      await syncCollection(prisma.integrationMessage, tenantId, body.integrationMessages, (m) => ({
        eventId: m.eventId, correlationId: m.correlationId, type: m.type, direction: m.direction, source: m.source,
        destination: m.destination, status: m.status || "pending", payloadSummary: m.payloadSummary || "", attempts: m.attempts || 1,
        createdAt: d(m.createdAt) || undefined,
      }));
    }

    if (body.auditEvents) {
      // La auditoría solo crece — nunca se borran eventos desde aquí, aunque el
      // navegador mande una lista más corta (por ejemplo, si solo carga los últimos 300).
      for (const ev of body.auditEvents) {
        await prisma.auditEvent.upsert({
          where: { id: ev.id },
          create: { id: ev.id, tenantId, userId: ev.userId || null, userName: ev.userName || null, action: ev.action, entityType: ev.entityType, entityId: ev.entityId || null, before: j(ev.before, null), after: j(ev.after, null), timestamp: d(ev.timestamp) || undefined },
          update: {},
        });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
