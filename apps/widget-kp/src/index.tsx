import { advancedSettingsUrl, createMounter, currentLeadId, safe, settingsHost, type AmoWidgetSelf } from '@ai-door/widget-core';
import { KpApi } from './api.ts';
import { KpBlock } from './components/KpBlock.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';

declare const __API_URL__: string;
declare const __STYLES__: string;

type Callbacks = Record<string, (...args: unknown[]) => unknown>;

/**
 * Точка входа виджета «АИ-агент КП». Сборка оборачивает её в AMD-модуль (script.js):
 * `define([], () => function () { this.callbacks = createCallbacks(this); })`.
 * Виджет живёт в карточке сделки (блок КП) и на странице настроек; с агентом делит только бэкенд.
 */
export function createCallbacks(self: AmoWidgetSelf, apiUrl: string = __API_URL__): Callbacks {
  const api = new KpApi(self, apiUrl);
  const { mount, unmountAll } = createMounter(typeof __STYLES__ === 'string' ? __STYLES__ : '');
  const code = () => self.get_settings().widget_code;

  return {
    init: safe(() => undefined),
    bind_actions: safe(() => undefined),

    render: safe(() => {
      if (self.system().area !== 'lcard') return;
      const leadId = currentLeadId();
      if (!leadId) return;
      const id = `ai-door-kp-${code()}`;
      self.render_template({ caption: { class_name: 'ai-door-caption' }, body: '', render: `<div id="${id}"></div>` });
      mount('lcard', document.getElementById(id), <KpBlock api={api} leadId={leadId} />);
    }),

    settings: safe((...args: unknown[]) => {
      mount('settings', settingsHost(args[0]), <SettingsPage api={api} fullPageUrl={advancedSettingsUrl(code())} />);
    }),

    advancedSettings: safe(() => {
      mount('advanced', document.getElementById(`work-area-${code()}`), <SettingsPage api={api} />);
    }),

    onSave: () => true,
    destroy: safe(unmountAll),
  };
}
