// Validation against a flat JSON-schema subset (the one cc allows for tool
// manifests): object input, typed properties, enum, bounds, lengths, pattern,
// required, defaults; unknown keys are refused. Shared by the MCP handlers and
// the human play routes (src/play.js).

// Returns {args} (with defaults filled) or {error}.
export function validate(schema, input) {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'arguments must be an object' };
  const props = schema.properties || {};
  const out = {};
  for (const k of Object.keys(input)) if (!(k in props)) return { error: `unknown argument '${k}'` };
  for (const k of schema.required || []) if (input[k] === undefined) return { error: `missing required argument '${k}'` };
  for (const [k, spec] of Object.entries(props)) {
    let v = input[k];
    if (v === undefined) {
      if (spec.default !== undefined) out[k] = spec.default;
      continue;
    }
    const ok = spec.type === 'integer' ? Number.isInteger(v) : spec.type === 'boolean' ? typeof v === 'boolean' : typeof v === spec.type;
    if (!ok) return { error: `'${k}' must be ${spec.type === 'integer' ? 'an integer' : `a ${spec.type}`}` };
    if (spec.enum && !spec.enum.includes(v)) return { error: `'${k}' must be one of ${spec.enum.join(', ')}` };
    if (spec.minimum !== undefined && v < spec.minimum) return { error: `'${k}' must be >= ${spec.minimum}` };
    if (spec.maximum !== undefined && v > spec.maximum) return { error: `'${k}' must be <= ${spec.maximum}` };
    if (spec.maxLength !== undefined && v.length > spec.maxLength) return { error: `'${k}' must be at most ${spec.maxLength} characters` };
    if (spec.minLength !== undefined && v.length < spec.minLength) return { error: `'${k}' must be at least ${spec.minLength} characters` };
    if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(v)) return { error: `'${k}' is malformed` };
    out[k] = v;
  }
  return { args: out };
}
