// ---------------------------------------------------------------------------------
// Informe en el formato que Clinic-Os sabe recibir (perfil "clinicos").
//
// Clinic-Os empareja por IDENTIFICADORES (no por referencias de Diagnostic OS) y lee el texto
// del resultado desde `conclusion`:
//   subject.identifier   = cédula del paciente         (system urn:ec:cedula)
//   basedOn[0].identifier = orden que Clinic-Os envió   (system urn:clinicos:lab-order)
//   conclusion           = conclusión + valores del examen en texto (máx. ~4000 caracteres)
//   meta.versionId       = versión del informe (Clinic-Os deduplica por id + versión)
// Los valores estructurados (Observation) y los adjuntos viajan solo en el perfil "full".
// ---------------------------------------------------------------------------------
import { reportToDiagnosticReport, externalSystemOf, SYSTEMS } from "./fhir.js";

export const MAX_TEXT = 3800; // Clinic-Os guarda hasta 4000 caracteres de resultado

/** Texto legible del resultado: lo que el médico verá en Clinic-Os. */
export function resultText(report, results = []) {
  if (report.type !== "LAB") {
    return [report.findings && `Hallazgos: ${report.findings}`, report.impression && `Impresión: ${report.impression}`, report.conclusion].filter(Boolean).join("\n\n");
  }
  const lines = results.map((r) => {
    const flag = r.flag && r.flag !== "normal" ? ` [${String(r.flag).toUpperCase()}]` : "";
    const ref = r.referenceRange ? ` (ref. ${r.referenceRange})` : "";
    const value = String(r.value ?? "").trim() === "" ? "(sin valor)" : r.value;
    return `- ${r.analyte}: ${value}${r.unit ? ` ${r.unit}` : ""}${ref}${flag}`;
  });
  return [report.conclusion, lines.length ? `Resultados:\n${lines.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

/** Devuelve { payload } o { skip: "motivo" } si este informe no se puede entregar a Clinic-Os. */
export function buildClinicOsReport({ tenant, report, order, study, patient, results }) {
  const labOrderId = study?.externalStudyId || order?.externalOrderId;
  if (!labOrderId) return { skip: "La orden no viene de Clinic-Os (sin identificador externo); no hay a qué orden adjuntar el resultado." };
  if (!patient || patient.documentType !== "cedula" || !patient.documentNumber) return { skip: "El paciente no tiene cédula registrada; Clinic-Os empareja por cédula." };

  let text = resultText(report, results);
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n… (resultado completo en Diagnostic OS)`;
  const base = reportToDiagnosticReport(report, order, study); // para category y code

  return {
    payload: {
      resourceType: "DiagnosticReport",
      id: report.id,
      meta: { versionId: String(report.version || 1) },
      identifier: [{ system: SYSTEMS.dxReport, value: report.id }],
      status: report.status === "published" ? "final" : base.status, // Clinic-Os distingue las correcciones por meta.versionId
      category: base.category,
      code: base.code,
      subject: { identifier: { system: SYSTEMS.cedula, value: patient.documentNumber } },
      // Se devuelve EXACTAMENTE el identificador que la clínica envió (mismo system y mismo value): así
      // reconoce su orden aunque su formato incluya el id de la clínica. Si no envió "system", se usa el de Clinic-Os.
      basedOn: [{ identifier: { system: externalSystemOf(order) || SYSTEMS.clinicosLabOrder, value: String(labOrderId) } }],
      effectiveDateTime: report.publishedAt ? new Date(report.publishedAt).toISOString() : undefined,
      performer: [{ display: tenant?.name || "Diagnostic OS" }],
      conclusion: text || undefined,
    },
  };
}
