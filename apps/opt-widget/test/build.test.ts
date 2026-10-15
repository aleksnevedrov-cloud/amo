import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
let files: Record<string, Uint8Array>;
let zipBytes = 0;
const text = (name: string) => new TextDecoder().decode(files[name]);

beforeAll(() => {
  execFileSync('node', ['scripts/build.mjs'], { cwd: root, env: { ...process.env, WIDGET_API_URL: 'https://opt.test.ru' } });
  const zip = readFileSync(`${root}/dist/widget.zip`);
  zipBytes = zip.length;
  files = unzipSync(new Uint8Array(zip));
}, 60_000);

describe('архив виджета «Агент опт»', () => {
  it('обязательные файлы в корне, версия из package.json, свои стили с префиксом opt-', () => {
    for (const f of ['manifest.json', 'script.js', 'style.css', 'i18n/ru.json', 'i18n/en.json', 'images/logo.png']) expect(files[f], f).toBeDefined();
    const m = JSON.parse(text('manifest.json'));
    expect(m.widget.version).toBe(JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).version);
    expect(m.widget.interface_version).toBe(2);
    expect(text('style.css')).toContain('.opt-btn');
    expect(text('style.css')).not.toContain('.ai-door-');
    expect(text('script.js')).toContain('ai-door-opt-styles');
  });

  it('только карточка сделки и настройки — без шага Salesbot', () => {
    const m = JSON.parse(text('manifest.json'));
    expect(m.locations).toEqual(['settings', 'advanced_settings', 'lcard-1']);
    expect(m.salesbot_designer).toBeUndefined();
  });

  it('все ключи перевода из манифеста есть в ru и en', () => {
    const m = JSON.parse(text('manifest.json'));
    const keys = [m.widget.name, m.widget.description, m.widget.short_description, m.advanced.title, m.settings.custom.name];
    for (const lang of ['ru', 'en']) {
      const dict = JSON.parse(text(`i18n/${lang}.json`));
      for (const k of keys) {
        const v = k.split('.').reduce((o: Record<string, unknown> | undefined, p: string) => o?.[p] as never, dict);
        expect(typeof v, `${lang}: ${k}`).toBe('string');
      }
    }
    expect(JSON.parse(text('i18n/ru.json')).widget.name).toBe('Агент опт');
  });

  it('script.js — AMD-модуль со своим именем бандла, без кода розницы и без мусора в window', () => {
    let factory: (() => (this: object) => void) | undefined;
    const define = (_deps: string[], f: typeof factory) => (factory = f);
    const sandbox: Record<string, unknown> = {};
    new Function('define', 'window', 'self', 'globalThis', text('script.js'))(define, sandbox, sandbox, sandbox);
    const Ctor = factory!();
    const self = { get_settings: () => ({ widget_code: 'opt' }) };
    Ctor.call(self);
    const cbs = (self as unknown as { callbacks: Record<string, unknown> }).callbacks;
    for (const name of ['init', 'render', 'bind_actions', 'settings', 'advancedSettings', 'onSave', 'destroy']) expect(cbs[name], name).toBeTypeOf('function');
    expect(cbs.onSalesbotDesignerSave).toBeUndefined();
    expect(Object.keys(sandbox)).not.toContain('__aiDoorOptWidget');
    expect(text('script.js')).toContain('https://opt.test.ru');
    // Экранов розницы в опте нет: ни песочницы, ни правил цен, ни Salesbot.
    for (const marker of ['Песочница', 'Правила цен', 'salesbot']) expect(text('script.js')).not.toContain(marker);
  });

  it('размер архива около 145 КБ: React 19 ≈ 215 КБ в script.js, свой код и стили ≈ 60 КБ, логотипы 40 КБ', () => {
    // После стилей по макету (DESIGN, DESIGN-FIX) архив 134 КБ; вкладка «База знаний» (RFD-AI-AGENT-OPT-KB: источники, ссылки,
    // прайсы, синонимы) добавила ≈ 20 КБ к script.js — архив 144 КБ, script.js 341 КБ; запас до 160 / 360.
    expect(zipBytes).toBeLessThan(160 * 1024);
    expect(files['script.js']!.length).toBeLessThan(360 * 1024);
  });
});
