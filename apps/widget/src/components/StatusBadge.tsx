import type { Mode, Status } from '../api.ts';
import { s } from './styles.ts';

const MODE_LABEL: Record<Mode, string> = {
  auto: 'Автоматический',
  semi: 'Полуавтоматический',
  hints: 'Только подсказки',
  off: 'Выключен',
};

export function modeLabel(mode: Mode) {
  return MODE_LABEL[mode];
}

export function ConnectionBadge({ status }: { status: Pick<Status, 'connected' | 'tokenError'> }) {
  if (status.connected) return <span style={s.badgeOk}>amoCRM подключён</span>;
  return <span style={s.badgeBad}>{status.tokenError ? 'Ошибка авторизации amoCRM' : 'amoCRM не подключён'}</span>;
}

export const rub = (n: number) => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const KIND_LABEL: Record<string, string> = {
  reply: 'Ответ',
  handoff: 'Передача менеджеру',
  pause: 'Пауза',
  resume: 'Возврат AI',
  skipped: 'Пропуск',
  blocked: 'Ответ заблокирован',
  error: 'Ошибка',
  note: 'Примечание',
  import: 'Импорт каталога',
  sandbox: 'Песочница',
};
export const kindLabel = (k: string) => KIND_LABEL[k] ?? k;
