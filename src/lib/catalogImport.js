import * as XLSX from "xlsx";

// ---------------------------------------------------------------------------------
// Convierte un archivo de lista de precios (Excel/CSV o PDF) en filas de catálogo
// {code, name, modality, price, preparation, estimatedTime} listas para revisar
// en el frontend antes de importarlas de verdad. Es "mejor esfuerzo": con Excel/CSV
// es confiable si hay encabezados reconocibles; con PDF depende del formato del
// documento, por eso siempre se muestra una vista previa editable antes de guardar.
// ---------------------------------------------------------------------------------

const HEADER_ALIASES = {
  code: ["codigo", "código", "code", "cod"],
  name: ["nombre", "examen", "estudio", "descripcion", "descripción", "servicio", "name", "prueba"],
  modality: ["modalidad", "tipo", "area", "área", "modality"],
  price: ["precio", "valor", "tarifa", "costo", "price"],
  preparation: ["preparacion", "preparación", "preparation", "indicaciones"],
  estimatedTime: ["tiempo", "duracion", "duración", "estimatedtime", "entrega"],
};

function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function matchField(header) {
  const norm = normalizeHeader(header);
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.some((a) => normalizeHeader(a) === norm)) return field;
  }
  return null;
}

function parsePrice(raw) {
  if (typeof raw === "number") return raw;
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^0-9.,]/g, "").replace(",", ".");
  const value = parseFloat(cleaned);
  return Number.isNaN(value) ? null : value;
}

function guessModality(text) {
  const t = normalizeHeader(text);
  if (/(rx|radiograf|rayos)/.test(t)) return "RX";
  if (/(eco|ultrasoni|ecograf)/.test(t)) return "ECO";
  return "LAB";
}

function autoCode(name, index) {
  const slug = String(name || "ITEM").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 18);
  return `IMP-${slug || "ITEM"}-${index}`;
}

function rowsFromSheetJson(json) {
  if (!json.length) return { items: [], warnings: ["El archivo no tiene filas de datos."] };

  const headers = Object.keys(json[0]);
  const fieldByHeader = {};
  headers.forEach((h) => { const f = matchField(h); if (f) fieldByHeader[h] = f; });

  const hasNameCol = Object.values(fieldByHeader).includes("name");
  const hasPriceCol = Object.values(fieldByHeader).includes("price");

  const warnings = [];
  const items = [];

  if (hasNameCol && hasPriceCol) {
    json.forEach((row, i) => {
      const item = {};
      for (const [header, field] of Object.entries(fieldByHeader)) item[field] = row[header];
      const name = String(item.name || "").trim();
      const price = parsePrice(item.price);
      if (!name || price === null) return;
      items.push({
        code: item.code ? String(item.code).trim().toUpperCase() : autoCode(name, i),
        name, price,
        modality: item.modality ? guessModality(item.modality) : guessModality(name),
        preparation: item.preparation ? String(item.preparation).trim() : "",
        estimatedTime: item.estimatedTime ? String(item.estimatedTime).trim() : "",
      });
    });
  } else {
    // Sin encabezados reconocibles: asumimos que las dos primeras columnas son
    // "nombre" y "precio", que es el formato más común en listas simples.
    warnings.push("No se reconocieron encabezados de columna — se asumió que la 1ª columna es el nombre y la 2ª el precio. Revisa cada fila antes de importar.");
    json.forEach((row, i) => {
      const values = Object.values(row);
      const name = String(values[0] || "").trim();
      const price = parsePrice(values[1]);
      if (!name || price === null) return;
      items.push({ code: autoCode(name, i), name, price, modality: guessModality(name), preparation: "", estimatedTime: "" });
    });
  }

  if (!items.length) warnings.push("No se pudo extraer ninguna fila válida (nombre + precio) del archivo.");
  return { items, warnings };
}

export function parseSpreadsheet(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  return rowsFromSheetJson(json);
}

export async function parsePdf(buffer) {
  const pdfParse = (await import("pdf-parse")).default;
  const data = await pdfParse(buffer);
  const lines = data.text.split("\n").map((l) => l.trim()).filter(Boolean);

  const items = [];
  const priceAtEnd = /^(.*?)[\s.:\-]{1,}\$?\s*([0-9]+(?:[.,][0-9]{1,2})?)\s*$/;

  lines.forEach((line, i) => {
    const m = line.match(priceAtEnd);
    if (!m) return;
    const name = m[1].replace(/[.\-\s]+$/, "").trim();
    const price = parsePrice(m[2]);
    if (!name || price === null || name.length < 3) return;
    items.push({ code: autoCode(name, i), name, price, modality: guessModality(name), preparation: "", estimatedTime: "" });
  });

  const warnings = ["La extracción desde PDF es aproximada — revisa cada fila con cuidado antes de importar."];
  if (!items.length) warnings.push("No se detectaron líneas con el formato \"nombre ... precio\" en este PDF.");
  return { items, warnings };
}
