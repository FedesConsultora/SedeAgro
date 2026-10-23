export class HttpError extends Error {
  constructor(status, message, details = undefined, code = undefined, hint = undefined) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
    this.hint = hint;
    this.expose = status < 500;
  }
}

export function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// Upper bound on all nodes of untrusted JSON passed to Zod, not its byte size.
// Express already caps bytes (10 MB); a long photo/base64 STRING is one node.
// Old Zod versions may accumulate one validation issue per malformed element
// even when a schema declares .max(): stop pathological fanout before safeParse.
export const MAX_VALIDATION_NODES = 4096;

export function withinValidationBudget(root) {
  const pending = [root];
  const seen = new WeakSet();
  let counted = 0;
  while (pending.length) {
    const node = pending.pop();
    counted += 1;
    if (counted > MAX_VALIDATION_NODES) return false;
    if (node === null || typeof node !== 'object') continue;
    // HTTP JSON cannot contain cycles/shared references; reject unexpected
    // programmatically injected graphs instead of processing indefinitely.
    if (seen.has(node)) return false;
    seen.add(node);
    const keys = Array.isArray(node) ? null : Object.keys(node);
    const children = Array.isArray(node) ? node : keys.map(key => node[key]);
    // Include queued nodes in the limit before allocating any large stack.
    if (counted + pending.length + children.length > MAX_VALIDATION_NODES) return false;
    for (const child of children) pending.push(child);
  }
  return true;
}

export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    if (!withinValidationBudget(req[source])) {
      return next(new HttpError(413, 'La solicitud contiene demasiados elementos.',
        undefined, 'VALIDATION_BUDGET_EXCEEDED'));
    }
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(new HttpError(422, 'Datos inválidos', result.error.flatten(), 'VALIDATION_ERROR'));
    }
    req[source] = result.data;
    next();
  };
}
