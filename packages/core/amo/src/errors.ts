export class AmoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'AmoError';
  }
}

/** amo отклонил refresh-токен: интеграцию нужно переустановить. */
export class AmoAuthRevokedError extends AmoError {
  override name = 'AmoAuthRevokedError';
}
