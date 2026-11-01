import { useCallback, useEffect, useState } from 'react';

export type LoadState<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

export function useLoad<T>(load: () => Promise<T>): [LoadState<T>, () => void] {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' });
  const run = useCallback(() => {
    setState({ status: 'loading' });
    load().then(
      (data) => setState({ status: 'ready', data }),
      (err: unknown) => setState({ status: 'error', message: errorMessage(err) }),
    );
  }, [load]);
  useEffect(run, [run]);
  return [state, run];
}

export function errorMessage(err: unknown): string {
  const e = err as { status?: number; reason?: string; attempts?: number } | null;
  const status = e?.status;
  if (status === 401) return 'Нет доступа к серверу AI-агента (401). Переустановите интеграцию.';
  // Причина после автоповторов (RETRY): «таймаут», «нет соединения», «HTTP 502».
  if (status === 0 || (status === undefined && e?.reason)) return `Сервер AI-агента недоступен${e?.reason ? ` (${e.reason}${(e.attempts ?? 1) > 1 ? ', после повторов' : ''})` : ''}.`;
  // Понятные ошибки сервера (например, «Формат не поддерживается») показываем как есть.
  const message = (err as { responseJSON?: { message?: unknown } } | null)?.responseJSON?.message;
  if (typeof message === 'string' && message) return message;
  if (status !== undefined && status >= 500) return `Сервер AI-агента ответил ошибкой (HTTP ${status}).`;
  return 'Не удалось загрузить данные AI-агента.';
}
