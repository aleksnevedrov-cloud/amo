import { useState } from 'react';
import { s } from '@ai-door/widget-core';
import type { KpApi } from '../api.ts';
import { KpSettings } from './KpSettings.tsx';

const TABS = [['settings', 'Настройки КП']] as const;
type Tab = (typeof TABS)[number][0];

/**
 * Настройки виджета «АИ-агент КП». Рисуется и на своей странице (advanced_settings),
 * и в модальном окне интеграции — тогда `fullPageUrl` даёт ссылку на полноэкранный вариант.
 */
export function SettingsPage({ api, fullPageUrl }: { api: KpApi; fullPageUrl?: string }) {
  const [tab, setTab] = useState<Tab>('settings');
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
      {tab === 'settings' && <KpSettings api={api} />}
    </div>
  );
}
