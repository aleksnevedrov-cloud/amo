import { createRoot, type Root } from 'react-dom/client';
import { currentLeadId, type AmoWidgetSelf } from './amo.ts';
import { WidgetApi } from './api.ts';
import { LeadPanel } from './components/LeadPanel.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';
import { SettingsStatus } from './components/SettingsStatus.tsx';

declare const __API_URL__: string;

type Callbacks = Record<string, (...args: unknown[]) => unknown>;

/**
 * Точка входа виджета. Сборка оборачивает её в AMD-модуль, который amo грузит как script.js:
 * `define([], () => function () { this.callbacks = createCallbacks(this); })`.
 * Любая ошибка ловится внутри: виджет не должен ломать карточку и другие виджеты.
 */
export function createCallbacks(self: AmoWidgetSelf, apiUrl: string = __API_URL__): Callbacks {
  const api = new WidgetApi(self, apiUrl);
  const roots = new Map<string, Root>();
  const code = () => self.get_settings().widget_code;

  const mount = (key: string, el: Element | null, node: React.ReactNode) => {
    if (!el) return;
    roots.get(key)?.unmount();
    const root = createRoot(el);
    root.render(node);
    roots.set(key, root);
  };

  const safe =
    <A extends unknown[]>(fn: (...args: A) => unknown) =>
    (...args: A) => {
      try {
        fn(...args);
      } catch (err) {
        // eslint-disable-next-line no-console -- единственный канал диагностики внутри amo
        console.error('[ai-door] widget error', err);
      }
      return true;
    };

  return {
    init: safe(() => undefined),
    bind_actions: safe(() => undefined),

    render: safe(() => {
      if (self.system().area !== 'lcard') return;
      const leadId = currentLeadId();
      if (!leadId) return;
      const id = `ai-door-panel-${code()}`;
      self.render_template({
        caption: { class_name: 'ai-door-caption' },
        body: '',
        render: `<div id="${id}"></div>`,
      });
      mount('lcard', document.getElementById(id), <LeadPanel api={api} leadId={leadId} />);
    }),

    settings: safe((...args: unknown[]) => {
      // amo передаёт jQuery-объект модального окна настроек.
      const modal = args[0] as { find?: (sel: string) => { get?: (i: number) => Element | undefined } } | undefined;
      const host = document.createElement('div');
      const block = modal?.find?.('.widget_settings_block')?.get?.(0);
      if (!block) return;
      block.appendChild(host);
      mount('settings', host, <SettingsStatus api={api} />);
    }),

    advancedSettings: safe(() => {
      mount('advanced', document.getElementById(`work-area-${code()}`), <SettingsPage api={api} />);
    }),

    onSave: () => true,

    destroy: safe(() => {
      for (const root of roots.values()) root.unmount();
      roots.clear();
    }),
  };
}
