import { advancedSettingsUrl, createMounter, currentLeadId, safe, settingsHost, type AmoWidgetSelf } from '@ai-door/widget-core';
import { WidgetApi } from './api.ts';
import { LeadPanel } from './components/LeadPanel.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';

declare const __API_URL__: string;
declare const __STYLES__: string;

/**
 * Шаги Salesbot для обработчика виджета:
 *  ai_reply — входящее сообщение клиента уходит AI;
 *  ai_send — бот-отправщик забирает одобренный черновик (режим «Полуавто»).
 */
export function salesbotSteps(apiUrl: string, handler: string = 'ai_reply'): string {
  const data =
    handler === 'ai_send'
      ? { lead_id: '{{lead.id}}', kind: 'send' }
      : { lead_id: '{{lead.id}}', message: '{{message_text}}' };
  return JSON.stringify([
    {
      question: [{ handler: 'widget_request', params: { url: new URL('/salesbot/v1/hook', apiUrl).toString(), data } }],
    },
  ]);
}

type Callbacks = Record<string, (...args: unknown[]) => unknown>;

/**
 * Точка входа виджета. Сборка оборачивает её в AMD-модуль, который amo грузит как script.js:
 * `define([], () => function () { this.callbacks = createCallbacks(this); })`.
 * Любая ошибка ловится внутри: виджет не должен ломать карточку и другие виджеты.
 */
export function createCallbacks(self: AmoWidgetSelf, apiUrl: string = __API_URL__): Callbacks {
  const api = new WidgetApi(self, apiUrl);
  // В тестах и в dev-сборке define отсутствует — тогда стили просто не вставляются.
  const { mount, unmountAll } = createMounter(typeof __STYLES__ === 'string' ? __STYLES__ : '');
  const code = () => self.get_settings().widget_code;

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
      const path = typeof self.params?.path === 'string' ? self.params.path.replace(/\/$/, '') : '';
      mount('lcard', document.getElementById(id), <LeadPanel api={api} leadId={leadId} assetsUrl={path ? `${path}/images` : undefined} settingsUrl={advancedSettingsUrl(code())} />);
    }),

    /**
     * Модальное окно настроек интеграции. Здесь — полная форма настроек, а не только статус:
     * на живом аккаунте отдельная страница `advanced_settings` не видна в меню, и заказчику
     * нужно вводить ключ Anthropic и включать агента прямо отсюда. Та же форма доступна
     * на всю страницу по адресу /settings/widgets/<код>/ — ссылка сверху формы.
     */
    settings: safe((...args: unknown[]) => {
      mount('settings', settingsHost(args[0]), <SettingsPage api={api} fullPageUrl={advancedSettingsUrl(code())} />);
    }),

    advancedSettings: safe(() => {
      mount('advanced', document.getElementById(`work-area-${code()}`), <SettingsPage api={api} />);
    }),

    onSave: () => true,

    /**
     * Шаг виджета в конструкторе Salesbot. Возвращает JSON шагов бота:
     * widget_request отправляет сообщение клиента на бэкенд, бот ждёт continue с ответом AI.
     * Плейсхолдеры {{lead.id}} и {{message_text}} — по документации Salesbot; сверить при установке.
     */
    onSalesbotDesignerSave: (handlerCode?: unknown) => salesbotSteps(apiUrl, typeof handlerCode === 'string' ? handlerCode : 'ai_reply'),

    destroy: safe(unmountAll),
  };
}
