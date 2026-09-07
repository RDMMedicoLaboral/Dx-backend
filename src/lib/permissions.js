// Espejo del modelo de permisos del frontend (src/data/catalogs.js).
// La unidad de control es el permiso, no el rol.

export const PERMISSIONS = {
  MANAGE_CENTER: "manage_center",
  MANAGE_USERS: "manage_users",
  MANAGE_CATALOG: "manage_catalog",
  MANAGE_INTEGRATIONS: "manage_integrations",
  CREATE_ORDER: "create_order",
  MANAGE_SPECIMEN: "manage_specimen",
  ENTER_RESULT: "enter_result",
  VALIDATE_RESULT: "validate_result",
  CREATE_REPORT: "create_report",
  VALIDATE_REPORT: "validate_report",
  PUBLISH_REPORT: "publish_report",
  AMEND_REPORT: "amend_report",
  VIEW_AUDIT: "view_audit",
};

const ALL = Object.values(PERMISSIONS);
const CENTER_OWNER = ALL.filter((p) => p !== PERMISSIONS.MANAGE_INTEGRATIONS);

export const ROLE_PERMISSIONS = {
  dueno: CENTER_OWNER,
  platform_admin: ALL,
  recepcion: [PERMISSIONS.CREATE_ORDER],
  laboratorista: [PERMISSIONS.MANAGE_SPECIMEN, PERMISSIONS.ENTER_RESULT, PERMISSIONS.CREATE_REPORT],
  responsable_laboratorio: [PERMISSIONS.MANAGE_SPECIMEN, PERMISSIONS.ENTER_RESULT, PERMISSIONS.VALIDATE_RESULT, PERMISSIONS.CREATE_REPORT, PERMISSIONS.VALIDATE_REPORT, PERMISSIONS.PUBLISH_REPORT, PERMISSIONS.AMEND_REPORT],
  tecnologo_rx: [PERMISSIONS.CREATE_REPORT],
  ecografista: [PERMISSIONS.CREATE_REPORT, PERMISSIONS.VALIDATE_REPORT, PERMISSIONS.PUBLISH_REPORT],
  radiologo: [PERMISSIONS.CREATE_REPORT, PERMISSIONS.VALIDATE_REPORT, PERMISSIONS.PUBLISH_REPORT, PERMISSIONS.AMEND_REPORT],
  auditor: [PERMISSIONS.VIEW_AUDIT],
};

export function hasPermission(role, permission) {
  return (ROLE_PERMISSIONS[role] || []).includes(permission);
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "No autenticado" });
    if (!hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: "No tienes permiso para esta acción" });
    }
    next();
  };
}
