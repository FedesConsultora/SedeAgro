export class HttpError extends Error {
  constructor(status, message, details = undefined, code = undefined) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
    this.expose = status < 500;
  }
}

export function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(new HttpError(422, 'Datos inválidos', result.error.flatten(), 'VALIDATION_ERROR'));
    }
    req[source] = result.data;
    next();
  };
}
