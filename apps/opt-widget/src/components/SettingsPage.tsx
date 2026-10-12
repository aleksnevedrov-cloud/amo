import { useState } from 'react';
import { s } from '@core/widget-core';
import type { KpApi } from '../api.ts';
import { Journal } from './Journal.tsx';
import { KpSettings } from './KpSettings.tsx';
import { MailSettings } from './MailSettings.tsx';
import { ModelSettings } from './ModelSettings.tsx';

/** Вкладки «База знаний» и «Поиск цен» появятся на этапах 8 и 9 ТЗ. */
const TABS = [
  ['kp', 'КП'],
  ['model', 'Модель'],
  ['mail', 'Письмо'],
  ['journal', 'Журнал сборок'],
] as const;
type Tab = (typeof TABS)[number][0];

/**
 * Настройки «Агента опт». Рисуется и на своей странице (advanced_settings), и в модальном окне
 * интеграции — тогда `fullPageUrl` даёт ссылку на полноэкранный вариант.
 */
export function SettingsPage({ api, fullPageUrl }: { api: KpApi; fullPageUrl?: string }) {
  const [tab, setTab] = useState<Tab>('kp');
  return (
    <div style={s.root}>
      {fullPageUrl && (
        <div style={{ ...s.muted, ...s.small, marginBottom: 8 }}>
          <a href={fullPageUrl} target="_blank" rel="noreferrer">Открыть настройки на всю страницу</a>
        </div>
      )}
      <div style={s.tabs}>
        {TABS.map(([id, label]) => (
          <button key={id} type="button" style={{ ...s.tab, ...(tab === id ? s.tabActive : {}) }} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'kp' && <KpSettings api={api} />}
      {tab === 'model' && <ModelSettings api={api} />}
      {tab === 'mail' && <MailSettings api={api} />}
      {tab === 'journal' && <Journal api={api} />}
    </div>
  );
}
