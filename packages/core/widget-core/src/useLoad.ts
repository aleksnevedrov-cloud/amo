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
  const status = (err as { status?: number } | null)?.status;
  if (status === 401) return 'Нет доступа к серверу AI-агента. Переустановите интеграцию.';
  if (status === 0) return 'Сервер AI-агента недоступен.';
  // Понятные ошибки сервера (например, «Формат не поддерживается») показываем как есть.
  const message = (err as { responseJSON?: { message?: unknown } } | null)?.responseJSON?.message;
  if (typeof message === 'string' && message) return message;
  return 'Не удалось загрузить данные AI-агента.';
}
