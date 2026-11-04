import { Agent as HttpAgent } from 'node:http';
import type { WAMessage } from 'baileys';
import { getGlobalDispatcher, ProxyAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import { AmojoClient } from '../src/amojo/client.ts';
import { loadEnv } from '../src/config.ts';
import { TelegramBotConnector } from '../src/connectors/telegram-bot.ts';
import type { ConnectorSink } from '../src/connectors/types.ts';
import { WhatsAppConnector, type WhatsAppDeps } from '../src/connectors/whatsapp.ts';
import { createMessengerProxy, maskProxyUrl, proxySecrets, redactSecrets } from '../src/proxy.ts';
import { downloadFromAmo } from '../src/safe-fetch.ts';

const PROXY = 'http://user1:s3cr%40t@203.0.113.7:3128';

type Seen = { url: string; dispatcher: unknown };
function spyFetch(seen: Seen[], respond: (url: string) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({ url, dispatcher: (init as { dispatcher?: unknown } | undefined)?.dispatcher });
    return respond(url);
  }) as typeof fetch;
}

const okJson = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });

/** Telegram: отправка текста, файла и скачивание файла; возвращает, какой dispatcher получил каждый запрос. */
async function telegramRequests(dispatcher: ProxyAgent | undefined): Promise<Seen[]> {
  const seen: Seen[] = [];
  const f = spyFetch(seen, (url) => {
    if (url.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3]));
    if (url.endsWith('/getFile')) return okJson({ file_path: 'photos/a.jpg', file_size: 3 });
    return okJson({ message_id: 1 });
  });
  const c = new TelegramBotConnector('123:abc', { fetch: f, ...(dispatcher ? { dispatcher } : {}) });
  await c.send({ externalChatId: '42', text: 'Здравствуйте', file: null, replyToExternalId: null });
  await c.send({ externalChatId: '42', text: '', file: { data: Buffer.from('x'), name: 'a.jpg', mime: 'image/jpeg', kind: 'picture' }, replyToExternalId: null });
  await c.download('file-1', 1000);
  return seen;
}

/** Поддельный сокет Baileys: запоминает конфиг и обработчики событий. */
function fakeWa(proxy: WhatsAppDeps['proxy']) {
  const configs: Record<string, unknown>[] = [];
  const handlers = new Map<string, (arg: unknown) => void>();
  const downloads: unknown[] = [];
  const sock = {
    ev: { on: (name: string, fn: (arg: unknown) => void) => void handlers.set(name, fn) },
    end: () => undefined,
    logout: async () => undefined,
    updateMediaMessage: async () => undefined,
  };
  const deps: WhatsAppDeps = {
    session: { load: async () => null, save: async () => undefined, clear: async () => undefined },
    onQr: async () => undefined,
    onIdentity: async () => true,
    ...(proxy ? { proxy } : {}),
    makeSocket: ((config: Record<string, unknown>) => {
      configs.push(config);
      return sock;
    }) as unknown as WhatsAppDeps['makeSocket'],
    downloadMedia: (async (_msg: WAMessage, _type: string, options: unknown) => {
      downloads.push(options);
      return Buffer.from('jpg');
    }) as unknown as WhatsAppDeps['downloadMedia'],
  };
  return { deps, configs, handlers, downloads };
}

async function whatsappRun(proxy: WhatsAppDeps['proxy']) {
  const w = fakeWa(proxy);
  const c = new WhatsAppConnector(w.deps);
  let inbound!: () => void;
  const got = new Promise<void>((r) => (inbound = r));
  const sink: ConnectorSink = { inbound: async () => inbound(), status: async () => undefined };
  await c.start(sink);
  const msg = {
    key: { remoteJid: '79991234567@s.whatsapp.net', id: 'IMG1', fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { imageMessage: { mimetype: 'image/jpeg' } },
  } as WAMessage;
  w.handlers.get('messages.upsert')?.({ messages: [msg], type: 'notify' });
  await got;
  await c.download('IMG1', 1000);
  await c.stop();
  return { config: w.configs[0] ?? {}, download: w.downloads[0] };
}

describe('прокси мессенджеров: кто получает агента', () => {
  const proxy = createMessengerProxy(PROXY)!;

  it('пустой адрес — прокси нет', () => {
    expect(createMessengerProxy('')).toBeNull();
    expect(createMessengerProxy('  ')).toBeNull();
    expect(createMessengerProxy(undefined)).toBeNull();
  });

  it('заданный адрес: undici ProxyAgent для fetch и http(s)-агент для node:https/ws', () => {
    expect(proxy.dispatcher).toBeInstanceOf(ProxyAgent);
    expect(proxy.agent).toBeInstanceOf(HttpAgent);
  });

  it('Telegram с прокси: getUpdates/отправка/скачивание файла — через ProxyAgent', async () => {
    const seen = await telegramRequests(proxy.dispatcher as ProxyAgent);
    expect(seen.map((s) => s.url.split('/').pop())).toEqual(['sendMessage', 'sendPhoto', 'getFile', 'a.jpg']);
    for (const s of seen) expect(s.dispatcher).toBe(proxy.dispatcher);
  });

  it('Telegram с прокси: long polling getUpdates — через ProxyAgent', async () => {
    const seen: Seen[] = [];
    let stopped!: () => void;
    const done = new Promise<void>((r) => (stopped = r));
    const f = spyFetch(seen, () => {
      stopped();
      return new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
    });
    const c = new TelegramBotConnector('123:abc', { fetch: f, dispatcher: proxy.dispatcher });
    await c.start({ inbound: async () => undefined, status: async () => undefined });
    await done;
    await c.stop();
    expect(seen[0]?.url.endsWith('/getUpdates')).toBe(true);
    expect(seen[0]?.dispatcher).toBe(proxy.dispatcher);
  });

  it('Telegram без прокси — напрямую', async () => {
    const seen = await telegramRequests(undefined);
    expect(seen).toHaveLength(4);
    for (const s of seen) expect(s.dispatcher).toBeUndefined();
  });

  it('WhatsApp с прокси: веб-сокет (agent), загрузка медиа (fetchAgent), скачивание медиа (dispatcher)', async () => {
    const r = await whatsappRun({ agent: proxy.agent, dispatcher: proxy.dispatcher });
    expect(r.config.agent).toBe(proxy.agent);
    // Baileys rc14 в Node загружает медиа через https.request({ agent: fetchAgent }) — нужен http(s)-агент.
    expect(r.config.fetchAgent).toBe(proxy.agent);
    expect(r.download).toEqual({ options: { dispatcher: proxy.dispatcher } });
  });

  it('WhatsApp без прокси — напрямую', async () => {
    const r = await whatsappRun(undefined);
    expect(r.config.agent).toBeUndefined();
    expect(r.config.fetchAgent).toBeUndefined();
    expect(r.download).toEqual({});
  });

  it('amojo и вложения amo идут напрямую: глобальный диспетчер не меняется, dispatcher не передаётся', async () => {
    const before = getGlobalDispatcher();
    createMessengerProxy(PROXY);
    expect(getGlobalDispatcher()).toBe(before);
    expect(getGlobalDispatcher()).not.toBeInstanceOf(ProxyAgent);

    const seen: Seen[] = [];
    const f = spyFetch(seen, (url) => (url.includes('amojo') ? new Response('{"scope_id":"s1"}') : new Response(new Uint8Array([1]))));
    await new AmojoClient({ baseUrl: 'https://amojo.amocrm.ru', channelId: 'ch', secret: 'sec', fetch: f }).connect('acc', 'РФ-Мессенджер');
    await downloadFromAmo('https://drive-b.amocrm.ru/file.jpg', {
      allowedDomains: ['amocrm.ru'],
      maxBytes: 100,
      fetch: f,
      resolve: async () => ['93.184.216.34'],
    });
    expect(seen).toHaveLength(2);
    for (const s of seen) expect(s.dispatcher).toBeUndefined();
  });
});

describe('прокси мессенджеров: конфигурация и журналы', () => {
  const base = {
    PUBLIC_URL: 'https://chat.example.ru',
    DATABASE_URL: 'postgres://u:p@localhost/db',
    REDIS_URL: 'redis://localhost:6379',
    AMO_CLIENT_ID: '0c9f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
    AMO_CLIENT_SECRET: 'x'.repeat(20),
    ENCRYPTION_KEY: 'a'.repeat(64),
    FILE_URL_SECRET: 'b'.repeat(40),
  };

  it('MESSENGER_PROXY_URL необязателен; принимает только http(s)', () => {
    expect(loadEnv(base).MESSENGER_PROXY_URL).toBe('');
    expect(loadEnv({ ...base, MESSENGER_PROXY_URL: PROXY }).MESSENGER_PROXY_URL).toBe(PROXY);
    expect(() => loadEnv({ ...base, MESSENGER_PROXY_URL: 'socks5://h:1' })).toThrow(/MESSENGER_PROXY_URL/);
    expect(() => loadEnv({ ...base, MESSENGER_PROXY_URL: 'не адрес' })).toThrow(/MESSENGER_PROXY_URL/);
  });

  it('ошибка конфигурации не раскрывает адрес прокси', () => {
    try {
      loadEnv({ ...base, MESSENGER_PROXY_URL: 'ftp://user1:s3cr3t@h:1' });
    } catch (err) {
      expect((err as Error).message).not.toContain('s3cr3t');
    }
  });

  it('в журнале логин и пароль прокси маскируются', () => {
    expect(maskProxyUrl(PROXY)).toBe('http://***:***@203.0.113.7:3128/');
    expect(maskProxyUrl('http://203.0.113.7:3128')).toBe('http://203.0.113.7:3128/');
    const line = JSON.stringify({ err: `connect failed ${PROXY} user1 s3cr@t s3cr%40t` });
    const out = redactSecrets(line, proxySecrets(PROXY));
    expect(out).not.toMatch(/user1|s3cr@t|s3cr%40t/);
    expect(redactSecrets('ok', proxySecrets(''))).toBe('ok');
  });
});
