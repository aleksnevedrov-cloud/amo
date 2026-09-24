import type { Status } from '../api.ts';
import { s } from './styles.ts';

const MODE_LABEL: Record<Status['mode'], string> = {
  auto: 'Автоматический',
  semi: 'Полуавтоматический',
  hints: 'Только подсказки',
  off: 'Выключен',
};

export function modeLabel(mode: Status['mode']) {
  return MODE_LABEL[mode];
}

export function ConnectionBadge({ status }: { status: Pick<Status, 'connected' | 'tokenError'> }) {
  if (status.connected) return <span style={s.badgeOk}>amoCRM подключён</span>;
  return <span style={s.badgeBad}>{status.tokenError ? 'Ошибка авторизации amoCRM' : 'amoCRM не подключён'}</span>;
}
