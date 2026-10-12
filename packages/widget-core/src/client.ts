import type { AmoWidgetSelf } from './amo.ts';

/**
 * Базовый клиент бэкенда для виджетов amo. Запросы идут через `$authorizedAjax` платформы:
 * amo сама добавляет одноразовый JWT (X-Auth-Token), ключей на клиенте нет.
 * Каждый виджет наследует класс и добавляет свои методы — сам транспорт один на всех.
 */
export class ApiClient {
  constructor(
    protected readonly self: AmoWidgetSelf,
    protected readonly baseUrl: string,
  ) {}

  protected async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.self.$authorizedAjax({
      url: new URL(path, this.baseUrl).toString(),
      method,
      type: method,
      dataType: 'json',
      ...(body === undefined ? {} : { data: JSON.stringify(body), contentType: 'application/json' }),
    });
    return res as T;
  }
}
