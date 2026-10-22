/**
 * Текст ошибки для журнала и поля error: у сетевых ошибок Node (undici) само сообщение — «fetch failed», причина лежит в
 * cause (код ENOTFOUND / ECONNREFUSED / ETIMEDOUT и текст getaddrinfo …). Таймаут AbortSignal — TimeoutError.
 */
export function errorText(err: unknown): string {
  const e = err as (Error & { cause?: { code?: string; message?: string } | null }) | null;
  if (!e) return String(err);
  if (e.name === 'TimeoutError') return `таймаут ответа (${e.message})`;
  const cause = e.cause;
  if (cause && typeof cause === 'object') {
    const code = typeof cause.code === 'string' ? cause.code : '';
    const msg = typeof cause.message === 'string' ? cause.message : '';
    if (code || msg) return `${e.message}: ${[code, msg].filter(Boolean).join(' ')}`;
  }
  return e.message || String(err);
}

const NETWORK_CODES = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_)/;

/** Сетевая ошибка (DNS, соединение, обрыв, таймаут) — не ошибка сервиса: повторяется без счёта попыток. */
export function isNetworkError(err: unknown): boolean {
  const e = err as (Error & { cause?: { code?: string } | null }) | null;
  if (!e) return false;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  if (e.message === 'fetch failed') return true;
  const code = e.cause && typeof e.cause === 'object' && typeof e.cause.code === 'string' ? e.cause.code : '';
  return NETWORK_CODES.test(code);
}
