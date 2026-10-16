// Base de datos en memoria que imita la parte de Prisma que usa el backend. Solo para pruebas.
import crypto from "node:crypto";

const DEFAULTS = {
  order: () => ({ status: "active", priority: "rutina", sourceType: "interno", convenioName: "Particular", totalAmount: 0, paidAmount: 0 }),
  study: () => ({ status: "scheduled", room: "", equipment: "", technician: "", bodySite: "", laterality: "", technique: "" }),
  patient: () => ({ matchStatus: "confirmado", documentType: "cedula", externalIdentifiers: [] }),
  tenant: () => ({ thirdPartyName: "Conector de terceros", thirdPartyAuthType: "apikey", thirdPartyScope: "system/DiagnosticReport.write", thirdPartyStatus: "No configurado", kind: "Laboratorio" }),
  integrationMessage: () => ({ status: "pending", attempts: 1, payloadSummary: "", eventId: crypto.randomUUID(), correlationId: crypto.randomUUID() }),
  diagnosticReport: () => ({ status: "draft", version: 1, resultIds: [], conclusion: "", findings: "", impression: "", amendmentReason: "" }),
  result: () => ({ status: "draft", flag: "normal", unit: "", referenceRange: "", method: "" }),
};

export function makeDb({ now = () => new Date() } = {}) {
  const tables = {};
  const clone = (o) => (o === undefined ? o : structuredClone(o));

  const cmp = (v, cond) => {
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, x]) => {
        if (op === "in") return x.includes(v);
        if (op === "not") return v !== x;
        if (op === "lt") return v != null && v < x;
        if (op === "lte") return v != null && v <= x;
        if (op === "gt") return v != null && v > x;
        if (op === "gte") return v != null && v >= x;
        if (op === "contains") return String(v ?? "").includes(x);
        return false;
      });
    }
    return v === cond;
  };
  const match = (row, where = {}) => Object.entries(where).every(([k, cond]) => {
    if (k === "OR") return cond.some((w) => match(row, w));
    if (k === "AND") return cond.every((w) => match(row, w));
    if (k === "NOT") return !match(row, cond);
    return cmp(row[k], cond);
  });

  function delegate(name) {
    const rows = (tables[name] ||= []);
    const withInclude = (row, include) => {
      const out = clone(row);
      if (include?.studies) out.studies = (tables.study || []).filter((s) => s.orderId === row.id).map(clone);
      return out;
    };
    const build = (data, extra = {}) => {
      const t = now();
      const { studies, ...plain } = data;
      const row = { id: crypto.randomUUID(), createdAt: t, updatedAt: t, ...(DEFAULTS[name]?.() || {}), ...extra };
      for (const [k, v] of Object.entries(plain)) if (v !== undefined) row[k] = v;
      return { row, studies };
    };
    return {
      async findMany({ where, take } = {}) { const r = rows.filter((x) => match(x, where)); return (take ? r.slice(0, take) : r).map(clone); },
      async findFirst({ where, include } = {}) { const r = rows.find((x) => match(x, where)); return r ? withInclude(r, include) : null; },
      async findUnique({ where }) { const r = rows.find((x) => match(x, where)); return r ? clone(r) : null; },
      async create({ data, include }) {
        const { row, studies } = build(data);
        rows.push(row);
        if (studies?.create) for (const s of studies.create) (tables.study ||= []).push(build(s, { orderId: row.id }).row);
        return withInclude(row, include);
      },
      async update({ where, data }) {
        const r = rows.find((x) => match(x, where));
        if (!r) throw new Error(`${name}: registro no encontrado`);
        for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = v && typeof v === "object" && "increment" in v ? (r[k] || 0) + v.increment : v;
        r.updatedAt = now();
        return clone(r);
      },
      async updateMany({ where, data }) {
        const hit = rows.filter((x) => match(x, where));
        hit.forEach((r) => { Object.assign(r, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined))); r.updatedAt = now(); });
        return { count: hit.length };
      },
      async upsert({ where, create, update }) {
        const r = rows.find((x) => match(x, where));
        if (r) { Object.assign(r, Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined))); r.updatedAt = now(); return clone(r); }
        const { row } = build(create); rows.push(row); return clone(row);
      },
      async deleteMany({ where }) {
        let count = 0;
        for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], where)) { rows.splice(i, 1); count++; }
        return { count };
      },
      async count({ where } = {}) { return rows.filter((x) => match(x, where)).length; },
      _rows: rows,
    };
  }

  const models = ["tenant", "user", "patient", "order", "study", "specimen", "result", "diagnosticReport", "catalogItem", "appointment", "integrationMessage", "auditEvent", "attachment", "convenio", "quote", "cashSession", "cashMovement"];
  const db = Object.fromEntries(models.map((m) => [m, delegate(m)]));
  db._tables = tables;
  return db;
}
