// Minimal JSON Schema (draft-07 subset) validator.
//
// The repository deliberately carries no npm dependency tree, so pulling ajv in
// just to check our own report envelope would be a much larger architectural
// change than the check is worth. This validates exactly the keywords used by
// scripts/qa/qa-report.schema.json and fails loudly on any keyword it does not
// implement, so the schema cannot quietly grow past the validator.

import fs from 'node:fs';

const SUPPORTED = new Set([
  '$schema', '$id', 'title', 'description',
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties',
  'items', 'pattern', 'minimum',
  // Conditional application. Needed so the published schema — not only the
  // constructor — can express that a field's legal values depend on a sibling
  // field, which is what pins the domain/identity invariant on issues.
  'if', 'then', 'else',
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

function validateNode(value, schema, pointer, errors) {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) {
      throw new Error(`qa-schema: unsupported schema keyword "${keyword}" at ${pointer || '#'}`);
    }
  }

  if ('const' in schema && value !== schema.const) {
    errors.push(`${pointer}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return;
  }

  if ('enum' in schema && !schema.enum.some((option) => option === value)) {
    errors.push(`${pointer}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
    return;
  }

  if ('type' in schema) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((expected) => matchesType(value, expected))) {
      errors.push(`${pointer}: expected type ${allowed.join('|')}, got ${typeOf(value)}`);
      return;
    }
  }

  if (typeof value === 'string' && 'pattern' in schema && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${pointer}: ${JSON.stringify(value)} does not match /${schema.pattern}/`);
  }

  if (typeof value === 'number' && 'minimum' in schema && value < schema.minimum) {
    errors.push(`${pointer}: ${value} is below minimum ${schema.minimum}`);
  }

  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${pointer}/${key}: required property missing`);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateNode(child, properties[key], `${pointer}/${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${pointer}/${key}: additional property is not allowed`);
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateNode(item, schema.items, `${pointer}/${index}`, errors));
  }

  // draft-07 if/then/else: the `if` subschema is a test, not an assertion, so
  // its own errors are discarded and only the selected branch contributes.
  // A missing branch means "no further constraint", per the specification.
  if ('if' in schema) {
    const probe = [];
    validateNode(value, schema.if, pointer, probe);
    const branch = probe.length === 0 ? schema.then : schema.else;
    if (branch) validateNode(value, branch, pointer, errors);
  }
}

export function validateAgainstSchema(document, schema) {
  const errors = [];
  validateNode(document, schema, '', errors);
  return errors;
}

export function loadSchema(schemaPath) {
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}
