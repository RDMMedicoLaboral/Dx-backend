import express from "express";

// Lector de cuerpos JSON para la API FHIR.
//
// El estándar FHIR identifica sus mensajes con el tipo "application/fhir+json" (y muchos sistemas envían
// "application/json", o incluso no indican tipo). El lector normal de Express solo acepta
// "application/json": con cualquier otro tipo deja el cuerpo VACÍO y la orden parece "no ser un
// ServiceRequest". Aquí se acepta cualquier tipo de contenido y se intenta leer como JSON.
export const fhirJsonParser = express.json({ limit: "2mb", type: () => true });
