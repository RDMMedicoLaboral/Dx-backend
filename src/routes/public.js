import { Router } from "express";
import { prisma } from "../lib/prisma.js";

const router = Router();

// Lista de centros y su catálogo activo, para el selector de la página de reservas.
router.get("/tenants", async (_req, res) => {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true, kind: true, hoursOpen: true, hoursClose: true } });
  res.json(tenants.map((t) => ({ id: t.id, name: t.name, kind: t.kind, hours: { open: t.hoursOpen, close: t.hoursClose } })));
});

router.get("/tenants/:tenantId/catalog", async (req, res) => {
  const items = await prisma.catalogItem.findMany({ where: { tenantId: req.params.tenantId, active: true } });
  res.json(items);
});

router.post("/appointments", async (req, res) => {
  const { tenantId, patientName, documentNumber, serviceCode, scheduledAt } = req.body || {};
  if (!tenantId || !patientName?.trim() || !documentNumber?.trim() || !serviceCode || !scheduledAt) {
    return res.status(400).json({ error: "Completa todos los campos de la reserva." });
  }
  const service = await prisma.catalogItem.findFirst({ where: { tenantId, code: serviceCode, active: true } });
  if (!service) return res.status(404).json({ error: "El estudio seleccionado ya no está disponible." });

  const appointment = await prisma.appointment.create({
    data: { tenantId, patientName: patientName.trim(), documentNumber: documentNumber.trim(), serviceCode: service.code, serviceName: service.name, modality: service.modality, scheduledAt: new Date(scheduledAt), source: "Reserva en línea" },
  });
  res.status(201).json(appointment);
});

export default router;
