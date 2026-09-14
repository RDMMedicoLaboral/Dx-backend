import { Router } from "express";
import multer from "multer";
import { authenticate, requireTenantUser } from "../middleware/auth.js";
import { requirePermission, PERMISSIONS } from "../lib/permissions.js";
import { parseSpreadsheet, parsePdf } from "../lib/catalogImport.js";

const router = Router();
router.use(authenticate, requireTenantUser, requirePermission(PERMISSIONS.MANAGE_CATALOG));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB

// POST /api/catalog-import  (multipart/form-data: file)
// Solo DEVUELVE una vista previa — no crea nada en el catálogo todavía. El
// centro revisa/edita las filas en pantalla y confirma con los endpoints
// normales de /api/catalog.
router.post("/", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Selecciona un archivo (Excel, CSV o PDF)." });
  const name = req.file.originalname.toLowerCase();

  try {
    let result;
    if (name.endsWith(".pdf")) {
      result = await parsePdf(req.file.buffer);
    } else if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv")) {
      result = parseSpreadsheet(req.file.buffer);
    } else {
      return res.status(400).json({ error: "Formato no soportado. Sube un archivo .xlsx, .xls, .csv o .pdf." });
    }
    res.json(result);
  } catch (err) {
    res.status(422).json({ error: `No se pudo leer el archivo: ${err.message}` });
  }
});

export default router;
