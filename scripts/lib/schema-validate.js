import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, "../../schemas");

const HANDOFF_SCHEMA = {
  implementer: "handoff-implementer.schema.json",
  "unified-reviewer": "handoff-unified-reviewer.schema.json",
  "spec-reviewer": "handoff-spec-reviewer.schema.json",
  "code-reviewer": "handoff-code-reviewer.schema.json",
  "integration-reviewer": "handoff-integration-reviewer.schema.json",
};

const cache = new Map();

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function matchesType(data, type) {
  if (Array.isArray(type)) return type.some((t) => matchesType(data, t));
  if (type === "integer") return Number.isInteger(data);
  if (type === "number") return typeof data === "number" && !Number.isNaN(data);
  if (type === "object") return isObject(data);
  if (type === "array") return Array.isArray(data);
  if (type === "null") return data === null;
  return typeOf(data) === type;
}

/**
 * Hand-rolled JSON Schema draft-07 subset validator.
 * Supports: type, enum, const, required, properties, additionalProperties,
 * items, oneOf, anyOf, allOf, minLength, minimum, $ref (local file set).
 */
export function validate(schema, data, options = {}) {
  const errors = [];
  const rootSchemas = options.rootSchemas || new Map();
  const pathPrefix = options.path || "$";

  function fail(p, msg) {
    errors.push({ path: p, message: msg });
  }

  function resolveRef(ref) {
    if (!ref.startsWith("#") && rootSchemas.has(ref))
      return rootSchemas.get(ref);
    if (ref.startsWith("#/")) {
      const parts = ref.slice(2).split("/");
      let cur = schema;
      // When validating nested, $ref relative to loaded schema document
      cur = options.document || schema;
      for (const part of parts) {
        if (!cur || typeof cur !== "object") return null;
        cur = cur[part];
      }
      return cur;
    }
    // file basename lookup
    const base = path.basename(ref);
    if (rootSchemas.has(base)) return rootSchemas.get(base);
    return null;
  }

  function check(sch, val, p, document = options.document || sch) {
    if (!sch || typeof sch !== "object") return;

    if (sch.$ref) {
      const resolved = resolveRef(sch.$ref);
      if (!resolved) {
        fail(p, `unresolved $ref ${sch.$ref}`);
        return;
      }
      check(resolved, val, p, document);
      return;
    }

    if (sch.const !== undefined && val !== sch.const) {
      fail(p, `expected const ${JSON.stringify(sch.const)}`);
    }

    if (sch.enum && !sch.enum.includes(val)) {
      fail(
        p,
        `expected one of ${JSON.stringify(sch.enum)}, got ${JSON.stringify(val)}`,
      );
    }

    if (sch.type !== undefined && !matchesType(val, sch.type)) {
      fail(p, `expected type ${JSON.stringify(sch.type)}, got ${typeOf(val)}`);
      return;
    }

    if (
      typeof val === "string" &&
      sch.minLength !== undefined &&
      val.length < sch.minLength
    ) {
      fail(p, `string shorter than minLength ${sch.minLength}`);
    }

    if (
      typeof val === "number" &&
      sch.minimum !== undefined &&
      val < sch.minimum
    ) {
      fail(p, `number below minimum ${sch.minimum}`);
    }

    if (sch.oneOf) {
      const oks = sch.oneOf.filter((sub) => {
        const r = validate(sub, val, { ...options, document, path: p });
        return r.ok;
      });
      if (oks.length !== 1) fail(p, `oneOf matched ${oks.length} schemas`);
    }

    if (sch.anyOf) {
      const ok = sch.anyOf.some(
        (sub) => validate(sub, val, { ...options, document, path: p }).ok,
      );
      if (!ok) fail(p, "anyOf matched no schemas");
    }

    if (sch.allOf) {
      for (const sub of sch.allOf) check(sub, val, p, document);
    }

    if (isObject(val) && sch.properties) {
      for (const [key, sub] of Object.entries(sch.properties)) {
        if (Object.prototype.hasOwnProperty.call(val, key)) {
          check(sub, val[key], `${p}.${key}`, document);
        }
      }
      if (sch.required) {
        for (const key of sch.required) {
          if (!Object.prototype.hasOwnProperty.call(val, key)) {
            fail(`${p}.${key}`, "required property missing");
          }
        }
      }
      if (sch.additionalProperties === false) {
        for (const key of Object.keys(val)) {
          if (!sch.properties[key])
            fail(`${p}.${key}`, "additional property not allowed");
        }
      } else if (isObject(sch.additionalProperties)) {
        for (const key of Object.keys(val)) {
          if (!sch.properties[key]) {
            check(sch.additionalProperties, val[key], `${p}.${key}`, document);
          }
        }
      }
    }

    if (Array.isArray(val) && sch.items) {
      if (Array.isArray(sch.items)) {
        sch.items.forEach((sub, i) => {
          if (i < val.length) check(sub, val[i], `${p}[${i}]`, document);
        });
      } else {
        val.forEach((item, i) =>
          check(sch.items, item, `${p}[${i}]`, document),
        );
      }
    }
  }

  check(schema, data, pathPrefix);
  return { ok: errors.length === 0, errors };
}

export function loadSchema(name) {
  const file = name.endsWith(".json") ? name : `${name}.schema.json`;
  const full = path.isAbsolute(file) ? file : path.join(SCHEMAS_DIR, file);
  if (cache.has(full)) return cache.get(full);
  if (!fs.existsSync(full)) throw new Error(`schema not found: ${full}`);
  const schema = JSON.parse(fs.readFileSync(full, "utf8"));
  cache.set(full, schema);
  return schema;
}

export function loadAllSchemas() {
  const map = new Map();
  if (!fs.existsSync(SCHEMAS_DIR)) return map;
  for (const f of fs.readdirSync(SCHEMAS_DIR)) {
    if (!f.endsWith(".json")) continue;
    map.set(f, loadSchema(f));
  }
  return map;
}

export function validateHandoff(role, data) {
  const file = HANDOFF_SCHEMA[role];
  if (!file) {
    return {
      ok: false,
      errors: [{ path: "$", message: `unknown handoff role: ${role}` }],
    };
  }
  const schema = loadSchema(file);
  return validate(schema, data, {
    document: schema,
    rootSchemas: loadAllSchemas(),
  });
}

export function validateRunState(data) {
  const schema = loadSchema("run-state.schema.json");
  return validate(schema, data, {
    document: schema,
    rootSchemas: loadAllSchemas(),
  });
}

export function validateClassification(data) {
  const schema = loadSchema("classification-evidence.schema.json");
  return validate(schema, data, { document: schema });
}

export function validateDriftReport(data) {
  const schema = loadSchema("drift-report.schema.json");
  return validate(schema, data, { document: schema });
}

export function validateBlastReport(data) {
  const schema = loadSchema("blast-report.schema.json");
  return validate(schema, data, { document: schema });
}

export function validateImpactReport(data) {
  const schema = loadSchema("impact-report.schema.json");
  return validate(schema, data, {
    document: schema,
    rootSchemas: loadAllSchemas(),
  });
}

export { SCHEMAS_DIR, HANDOFF_SCHEMA };
