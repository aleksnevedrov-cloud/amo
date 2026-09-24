// @vitest-environment jsdom
import { widgetSettingsSchema } from '@ai-door/db';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { AmoWidgetSelf } from '../src/amo.ts';
import { createCallbacks } from '../src/index.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const click = (text: string) =>
  act(async () => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
    if (!b) throw new Error(`Нет кнопки «${text}»`);
    b.click();
  });
const type = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('вкладка «Почта»', () => {
  it('пресет, пароль, сохранение и проверка подключения', async () => {
    document.body.innerHTML = '<div id="work-area-ai_door"></div>';
    let saved = widgetSettingsSchema.parse({});
    const calls: { url: string; method?: string; data?: string }[] = [];
    const responses: Record<string, (d?: string) => unknown> = {
      'GET /widget/v1/status': () => ({ accountId: 1, isAdmin: true, connected: true, tokenExpiresAt: null, tokenError: null, enabled: true, mode: 'auto', llmConfigured: true, spend: { todayRub: 0, monthRub: 0 }, dailyLimitRub: null, catalog: { products: 0, lastImport: null } }),
      'GET /widget/v1/settings': () => ({ settings: saved, version: 1 }),
      'PUT /widget/v1/settings': (d) => ((saved = JSON.parse(d ?? '{}')), { settings: saved, version: 2 }),
      'GET /widget/v1/amo/dictionaries': () => ({ pipelines: [], taskTypes: [] }),
      'GET /widget/v1/email/status': () => ({ enabled: saved.email.enabled, hasPassword: true, folders: [{ folder: 'INBOX', lastOkAt: '2026-09-24T10:00:00Z', lastError: null }] }),
      'PUT /widget/v1/email/password': () => ({ ok: true }),
      'POST /widget/v1/email/test': () => ({ imap: 'ok', smtp: 'Invalid login: 535', sentFolder: 'Отправленные' }),
    };
    const self: AmoWidgetSelf = {
      get_settings: () => ({ widget_code: 'ai_door' }),
      system: () => ({ area: 'settings' }),
      i18n: () => '',
      render_template: () => undefined,
      $authorizedAjax: async (opts) => {
        calls.push(opts);
        return responses[`${opts.method} ${new URL(opts.url).pathname}`]?.(opts.data);
      },
    };
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.advancedSettings!());
    await flush();
    await click('Почта');
    await flush();
    expect(document.body.textContent).toContain('Пароль сохранён');

    await click('Яндекс');
    const inputs = () => [...document.querySelectorAll<HTMLInputElement>('input')];
    expect(inputs().some((i) => i.value === 'imap.yandex.ru')).toBe(true);
    await type(inputs().find((i) => i.placeholder === 'shop@rf-dveri.ru')!, 'shop@rf-dveri.ru');
    await act(async () => inputs().find((i) => i.type === 'checkbox')!.click());

    await type(inputs().find((i) => i.type === 'password')!, 'app-pass');
    await click('Сохранить пароль');
    await flush();
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/email/password'))!.data!)).toEqual({ password: 'app-pass' });

    await click('Сохранить');
    await flush();
    expect(saved.email).toMatchObject({ enabled: true, imapHost: 'imap.yandex.ru', smtpHost: 'smtp.yandex.ru', username: 'shop@rf-dveri.ru' });
    // Пароль не попадает в общие настройки.
    expect(JSON.stringify(saved)).not.toContain('app-pass');

    await click('Почта');
    await flush();
    await click('Проверить подключение');
    await flush();
    expect(document.body.textContent).toContain('Invalid login: 535');
    expect(document.body.textContent).toContain('Отправленные');
  });
});
