import bcrypt from "bcryptjs";
import { prisma } from "./prisma.js";

export async function runSeed() {
  const hash = (pw) => bcrypt.hash(pw, 10);

  await prisma.user.upsert({
    where: { email: "soporte@diagnosticos.app" },
    update: {},
    create: { name: "Soporte Diagnostic OS", email: "soporte@diagnosticos.app", role: "platform_admin", passwordHash: await hash("plataforma123") },
  });

  const sanRafael = await prisma.tenant.upsert({
    where: { id: "ten-001" }, update: {},
    create: { id: "ten-001", name: "Laboratorio Clínico San Rafael", kind: "Laboratorio", plan: "Profesional", hoursOpen: "07:00", hoursClose: "16:00" },
  });
  await prisma.user.upsert({ where: { email: "pandrade@sanrafael.demo" }, update: {}, create: { tenantId: sanRafael.id, name: "Dra. Patricia Andrade", role: "dueno", email: "pandrade@sanrafael.demo", passwordHash: await hash("demo123") } });
  await prisma.user.upsert({ where: { email: "floor@sanrafael.demo" }, update: {}, create: { tenantId: sanRafael.id, name: "Fernando Loor", role: "laboratorista", email: "floor@sanrafael.demo", passwordHash: await hash("demo123") } });

  await prisma.catalogItem.createMany({
    data: [
      { tenantId: sanRafael.id, code: "LAB-HEMO", name: "Hemograma completo", modality: "LAB", price: 12.5, preparation: "Ayuno no requerido.", estimatedTime: "2 horas", externalCodes: ["LOINC:58410-2"], reportTemplate: { conclusion: "Serie roja, blanca y plaquetaria dentro de parámetros normales para edad y sexo." } },
      { tenantId: sanRafael.id, code: "LAB-GLU", name: "Glucosa en ayunas", modality: "LAB", price: 6, preparation: "Ayuno de 8 horas.", estimatedTime: "1 hora", externalCodes: ["LOINC:1558-6"], reportTemplate: { conclusion: "Glucemia en ayunas dentro de rango de referencia." } },
      { tenantId: sanRafael.id, code: "LAB-LIP", name: "Perfil lipídico", modality: "LAB", price: 18, preparation: "Ayuno de 12 horas.", estimatedTime: "3 horas", externalCodes: ["LOINC:57698-3"], reportTemplate: { conclusion: "Perfil lipídico sin alteraciones significativas." } },
    ],
    skipDuplicates: true,
  });

  const mantaSalud = await prisma.tenant.upsert({
    where: { id: "ten-002" }, update: {},
    create: { id: "ten-002", name: "Centro Diagnóstico Manta Salud", kind: "Centro de imágenes", plan: "Estándar", hoursOpen: "08:00", hoursClose: "18:00" },
  });
  await prisma.user.upsert({ where: { email: "rcedeno@mantasalud.demo" }, update: {}, create: { tenantId: mantaSalud.id, name: "Ing. Ramiro Cedeño", role: "dueno", email: "rcedeno@mantasalud.demo", passwordHash: await hash("demo123") } });
  await prisma.user.upsert({ where: { email: "ksolorzano@mantasalud.demo" }, update: {}, create: { tenantId: mantaSalud.id, name: "Dra. Karina Solórzano", role: "radiologo", email: "ksolorzano@mantasalud.demo", passwordHash: await hash("demo123") } });
  await prisma.user.upsert({ where: { email: "bmendoza@mantasalud.demo" }, update: {}, create: { tenantId: mantaSalud.id, name: "Byron Mendoza", role: "tecnologo_rx", email: "bmendoza@mantasalud.demo", passwordHash: await hash("demo123") } });

  await prisma.catalogItem.createMany({
    data: [
      { tenantId: mantaSalud.id, code: "RX-TORAX", name: "Radiografía de tórax PA", modality: "RX", price: 15, preparation: "Retirar objetos metálicos.", estimatedTime: "20 minutos", externalCodes: ["LOINC:36643-5"], reportTemplate: { findings: "Campos pulmonares sin infiltrados. Silueta cardiaca conservada.", impression: "Radiografía de tórax sin hallazgos patológicos agudos." } },
      { tenantId: mantaSalud.id, code: "ECO-ABD", name: "Ecografía abdominal superior", modality: "ECO", price: 28, preparation: "Ayuno de 6 horas.", estimatedTime: "30 minutos", externalCodes: ["LOINC:24869-0"], reportTemplate: { findings: "Hígado, vesícula, vía biliar, páncreas y bazo sin alteraciones.", impression: "Ecografía abdominal superior sin hallazgos patológicos." } },
    ],
    skipDuplicates: true,
  });

  return {
    superadmin: "soporte@diagnosticos.app / plataforma123",
    duenoLab: "pandrade@sanrafael.demo / demo123",
    duenoImg: "rcedeno@mantasalud.demo / demo123",
  };
}
