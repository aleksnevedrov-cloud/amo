/**
 * Минимальное описание объекта виджета amo, который платформа передаёт в script.js.
 * Методы сверить с актуальной документацией amo при установке (п. 0.3 ТЗ).
 */
export interface AmoWidgetSelf {
  get_settings(): { widget_code: string; [key: string]: unknown };
  system(): { area?: string; subdomain?: string; amouser_id?: number };
  i18n(key: string): unknown;
  render_template(opts: { caption: { class_name: string }; body: string; render: string }): void;
  /** Запрос к нашему бэкенду: amo добавляет заголовок X-Auth-Token (одноразовый JWT). */
  $authorizedAjax(opts: {
    url: string;
    method?: string;
    type?: string;
    data?: string;
    contentType?: string;
    dataType?: string;
  }): PromiseLike<unknown>;
}

declare global {
  interface Window {
    APP?: { data?: { current_card?: { id?: number } } };
  }
}

export function currentLeadId(): number | null {
  const id = window.APP?.data?.current_card?.id;
  return typeof id === 'number' && id > 0 ? id : null;
}
