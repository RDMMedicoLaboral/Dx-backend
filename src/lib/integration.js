import { prisma } from "./prisma.js";
import { reportToDiagnosticReport } from "./fhir.js";

// Al publicar un informe, si el centro tiene un conector externo configurado
// (por el superadmin, en /api/admin), se lo enviamos al HCE en formato FHIR
// DiagnosticReport. Queda registrado como IntegrationMessage saliente para que
// se vea en el panel de integraciones, sea que el envío haya funcionado o no.
export async function pushReportToConnector(tenantId, report) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant?.thirdPartyBaseUrl) return; // no configurado: no hay nada que hacer

  const [order, study] = await Promise.all([
    prisma.order.findUnique({ where: { id: report.orderId } }),
    prisma.study.findUnique({ where: { id: report.studyId } }),
  ]);
  const fhirPayload = reportToDiagnosticReport(report, order, study);

  const message = await prisma.integrationMessage.create({
    data: {
      tenantId, type: "ReportPublished", direction: "outbound",
      source: "Diagnostic OS", destination: tenant.thirdPartyName || "Conector de terceros",
      status: "sent", payloadSummary: `DiagnosticReport/${report.id} → ${tenant.thirdPartyBaseUrl}`,
    },
  });

  try {
    const resp = await fetch(`${tenant.thirdPartyBaseUrl.replace(/\/$/, "")}/DiagnosticReport`, {
      method: "POST",
      headers: {
        "Content-Type": "application/fhir+json",
        ...(tenant.thirdPartyApiKey ? { Authorization: `Bearer ${tenant.thirdPartyApiKey}` } : {}),
      },
      body: JSON.stringify(fhirPayload),
    });
    await prisma.integrationMessage.update({
      where: { id: message.id },
      data: { status: resp.ok ? "acknowledged" : "failed", payloadSummary: `${message.payloadSummary} — HTTP ${resp.status}` },
    });
  } catch (err) {
    await prisma.integrationMessage.update({
      where: { id: message.id },
      data: { status: "failed", payloadSummary: `${message.payloadSummary} — ${err.message}` },
    });
  }
}
