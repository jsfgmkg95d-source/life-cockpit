export class AppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export function invalid(message: string): never {
  throw new AppError(400, 'VALIDATION_ERROR', message);
}
