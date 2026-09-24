import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
let files: Record<string, Uint8Array>;
const text = (name: string) => new TextDecoder().decode(files[name]);

beforeAll(() => {
  execFileSync('node', ['scripts/build.mjs'], { cwd: root, env: { ...process.env, WIDGET_API_URL: 'https://ai.test.ru' } });
  files = unzipSync(new Uint8Array(readFileSync(`${root}/dist/widget.zip`)));
}, 60_000);

const pngSize = (buf: Uint8Array) => {
  const v = new DataView(buf.buffer, buf.byteOffset);
  return [v.getUint32(16), v.getUint32(20)];
};

describe('архив виджета', () => {
  it('содержит обязательные файлы в корне', () => {
    for (const f of ['manifest.json', 'script.js', 'i18n/ru.json', 'i18n/en.json']) expect(files[f]).toBeDefined();
  });

  it('манифест объявляет нужные области и локали', () => {
    const m = JSON.parse(text('manifest.json'));
    expect(m.widget.interface_version).toBe(2);
    expect(m.widget.locale).toEqual(['ru', 'en']);
    expect(m.locations).toEqual(expect.arrayContaining(['settings', 'advanced_settings', 'lcard-1', 'salesbot_designer']));
    expect(m.widget.version).toBe('0.3.0');
  });

  it('все ключи перевода из манифеста есть в ru и en', () => {
    const m = JSON.parse(text('manifest.json'));
    const keys = [
      m.widget.name,
      m.widget.description,
      m.widget.short_description,
      m.advanced.title,
      m.settings.custom.name,
      ...Object.values(m.salesbot_designer as Record<string, { name: string }>).map((h) => h.name),
    ];
    for (const lang of ['ru', 'en']) {
      const dict = JSON.parse(text(`i18n/${lang}.json`));
      for (const k of keys) {
        const v = k.split('.').reduce((o: Record<string, unknown> | undefined, p: string) => o?.[p] as never, dict);
        expect(typeof v, `${lang}: ${k}`).toBe('string');
      }
    }
  });

  it('логотипы нужных размеров', () => {
    const expected: Record<string, number[]> = {
      'images/logo.png': [130, 100],
      'images/logo_main.png': [400, 272],
      'images/logo_medium.png': [240, 84],
      'images/logo_min.png': [84, 84],
      'images/logo_small.png': [108, 108],
    };
    for (const [f, size] of Object.entries(expected)) expect(pngSize(files[f] as Uint8Array), f).toEqual(size);
  });

  it('script.js — AMD-модуль, задающий callbacks, и не мусорит в window', () => {
    let factory: (() => (this: object) => void) | undefined;
    const define = (_deps: string[], f: typeof factory) => (factory = f);
    const sandbox: Record<string, unknown> = {};
    new Function('define', 'window', 'self', 'globalThis', text('script.js'))(define, sandbox, sandbox, sandbox);
    expect(factory).toBeTypeOf('function');
    const Ctor = factory!();
    const self = { get_settings: () => ({ widget_code: 'x' }) };
    Ctor.call(self);
    const cbs = (self as unknown as { callbacks: Record<string, unknown> }).callbacks;
    for (const name of ['init', 'render', 'bind_actions', 'settings', 'advancedSettings', 'onSave', 'destroy', 'onSalesbotDesignerSave']) {
      expect(cbs[name], name).toBeTypeOf('function');
    }
    expect(Object.keys(sandbox)).not.toContain('__aiDoorWidget');
  });

  it('адрес API вшит из WIDGET_API_URL', () => {
    expect(text('script.js')).toContain('https://ai.test.ru');
  });
});
