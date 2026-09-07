import { Router } from "express";
import multer from "multer";
import cloudinary from "../lib/cloudinary.js";
import { prisma } from "../lib/prisma.js";
import { authenticate, requireTenantUser } from "../middleware/auth.js";
import { logAudit } from "../lib/audit.js";

const router = Router();
router.use(authenticate, requireTenantUser);

// En memoria: el archivo nunca toca disco, se transmite directo a Cloudinary.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 25 MB

function uploadBufferToCloudinary(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder, resource_type: "auto" }, (err, result) => {
      if (err) reject(err); else resolve(result);
    });
    stream.end(buffer);
  });
}

// POST /api/uploads  (multipart/form-data: file, entityType, entityId, caption?)
router.post("/", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió ningún archivo." });
  const { entityType, entityId, caption } = req.body || {};
  if (!entityType || !entityId) return res.status(400).json({ error: "Falta indicar a qué registro pertenece el archivo (entityType / entityId)." });

  try {
    const result = await uploadBufferToCloudinary(req.file.buffer, `diagnostic-os/${req.user.tenantId}`);
    const attachment = await prisma.attachment.create({
      data: {
        tenantId: req.user.tenantId, entityType, entityId,
        url: result.secure_url, publicId: result.public_id, resourceType: result.resource_type,
        format: result.format, bytes: result.bytes, caption: caption || "", uploadedById: req.user.id,
      },
    });
    await logAudit({ tenantId: req.user.tenantId, userId: req.user.id, userName: req.user.name, action: "attachment.upload", entityType, entityId, after: { url: attachment.url } });
    res.status(201).json(attachment);
  } catch (err) {
    res.status(502).json({ error: `No se pudo subir el archivo a Cloudinary: ${err.message}` });
  }
});

// GET /api/uploads?entityType=Study&entityId=xxxx
router.get("/", async (req, res) => {
  const { entityType, entityId } = req.query;
  const where = { tenantId: req.user.tenantId };
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  res.json(await prisma.attachment.findMany({ where, orderBy: { createdAt: "desc" } }));
});

router.delete("/:id", async (req, res) => {
  const attachment = await prisma.attachment.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!attachment) return res.status(404).json({ error: "Archivo no encontrado." });
  try { await cloudinary.uploader.destroy(attachment.publicId, { resource_type: attachment.resourceType }); } catch { /* si ya no existe en Cloudinary, igual borramos el registro */ }
  await prisma.attachment.delete({ where: { id: attachment.id } });
  res.json({ ok: true });
});

export default router;
