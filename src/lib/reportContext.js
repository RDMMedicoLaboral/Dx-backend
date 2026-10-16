// Junta todo lo que hace falta para armar un DiagnosticReport autocontenido:
// orden, estudio, paciente (con cédula), resultados de laboratorio y archivos adjuntos.
export async function loadReportContext(db, report) {
  const tenantId = report.tenantId;
  const [order, study, patient, attachments] = await Promise.all([
    db.order.findUnique({ where: { id: report.orderId } }),
    db.study.findUnique({ where: { id: report.studyId } }),
    db.patient.findUnique({ where: { id: report.patientId } }),
    db.attachment.findMany({
      where: { tenantId, OR: [{ entityType: "DiagnosticReport", entityId: report.id }, { entityType: "Study", entityId: report.studyId }] },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  let results = [];
  if (report.type === "LAB") {
    const ids = Array.isArray(report.resultIds) ? report.resultIds : [];
    const rows = ids.length
      ? await db.result.findMany({ where: { id: { in: ids }, tenantId } })
      : await db.result.findMany({ where: { studyId: report.studyId, tenantId } });
    // Respeta el orden en que el laboratorio armó el informe y deja fuera borradores.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.length ? ids.map((id) => byId.get(id)).filter(Boolean) : rows;
    results = ordered.filter((r) => r.status !== "draft");
  }
  return { order, study, patient, attachments, results };
}
