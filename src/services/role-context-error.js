export class RoleContextAssemblerError extends Error {
  constructor(code, message, statusCode = 400, options) {
    super(message, options);
    this.name = "RoleContextAssemblerError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function roleContextError(code, message, statusCode, options) {
  return new RoleContextAssemblerError(code, message, statusCode, options);
}
