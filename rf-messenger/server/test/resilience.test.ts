import { describe, expect, it } from 'vitest';
import { AlertNotifier, collectProblems } from '../src/alerts.ts';
import type { Logger } from '../src/bridge.ts';
import { loadEnv } from '../src/config.ts';
import { retryDelayMs, TelegramApiError, TelegramBotApi, TelegramBotConnector } from '../src/connectors/telegram-bot.ts';
import type { ConnectorSink } from '../src/connectors/types.ts';
import { waReconnectDelayMs, WhatsAppConnector, type WhatsAppDeps } from '../src/connectors/whatsapp.ts';
import { createMessengerProxy, ProxySwitch, type MessengerProxy } from '../src/proxy.ts';
import { PROXY_STATUS_KEY, ProxyMonitor, readProxyStatus, type ProxyStatus } from '../src/proxy-monitor.ts';
import type { Channel } from '../src/store.ts';

const PRIMARY = 'http://user1:pr1m4ry@203.0.113.7:3128';
const FALLBACK = 'http://user2:f4llb4ck@198.51.100.9:8080';

const okJson = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
const errJson = (code: number, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ ok: false, error_code: code, description: `e${code}`, ...extra }), { status: code });

/** fetch по сценарию: каждый вызов берёт следующий ответ; 'net' — сетевая ошибка. */
function scripted(steps: (Response | 'net')[]) {
  const calls: { url: string; dispatcher: unknown }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), dispatcher: (init as { dispatcher?: unknown } | undefined)?.dispatcher });
    const step = steps.length > 1 ? steps.shift()! : steps[0]!;
    if (step === 'net') throw new TypeError('fetch failed http://user1:pr1m4ry@203.0.113.7');
    return step.clone();
  }) as typeof fetch;
  return { f, calls };
}

function recorder() {
  const delays: number[] = [];
  return { delays, retry: { sleep: async (ms: number) => void delays.push(ms), random: () => 0.5 } };
}

const lines: string[] = [];
const memLog: Logger = {
  info: (o, m) => void lines.push(`${m} ${JSON.stringify(o)}`),
  warn: (o, m) => void lines.push(`${m} ${JSON.stringify(o)}`),
  error: (o, m) => void lines.push(`${m} ${JSON.stringify(o)}`),
};

describe('Telegram: повторы запросов', () => {
  it('пауза 1–2–4–8–16 с со случайным разбросом ±25 %; для 429 — retry_after', () => {
    const net = new TelegramApiError(0, 'network error');
    expect([0, 1, 2, 3, 4].map((a) => retryDelayMs(a, net, () => 0.5))).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(retryDelayMs(0, net, () => 0)).toBe(750);
    expect(retryDelayMs(4, net, () => 1)).toBe(20000);
    expect(retryDelayMs(0, new TelegramApiError(429, 'Too Many Requests', 7))).toBe(7000);
  });

  it('сетевая ошибка и 5xx — повтор; после 2xx запрос не повторяется', async () => {
    const { f, calls } = scripted(['net', errJson(502), okJson({ message_id: 9 })]);
    const r = recorder();
    const c = new TelegramBotConnector('123:abc', { fetch: f, retry: r.retry });
    expect(await c.send({ externalChatId: '42', text: 'Здравствуйте', file: null, replyToExternalId: null })).toEqual({ externalMessageId: '9' });
    expect(calls.map((x) => x.url.split('/').pop())).toEqual(['sendMessage', 'sendMessage', 'sendMessage']);
    expect(r.delays).toEqual([1000, 2000]);
  });

  it('429 ждёт retry_after из ответа', async () => {
    const { f, calls } = scripted([errJson(429, { parameters: { retry_after: 3 } }), okJson({ message_id: 1 })]);
    const r = recorder();
    await new TelegramBotApi('123:abc', { fetch: f, retry: r.retry }).call('sendMessage', { chat_id: 1, text: 'x' });
    expect(calls).toHaveLength(2);
    expect(r.delays).toEqual([3000]);
  });

  it('не больше 5 повторов, затем ошибка без токена и адреса прокси', async () => {
    const { f, calls } = scripted(['net']);
    const r = recorder();
    const err = await new TelegramBotApi('123:secret-token', { fetch: f, retry: r.retry }).call('getMe').catch((e: Error) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(calls).toHaveLength(6);
    expect(r.delays).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(String((err as Error).message)).not.toMatch(/secret-token|pr1m4ry|203\.0\.113/);
  });

  it('4xx (кроме 429) не повторяется: 400 и 403 — постоянная ошибка отправки', async () => {
    const { f, calls } = scripted([errJson(403)]);
    const c = new TelegramBotConnector('123:abc', { fetch: f, retry: recorder().retry });
    await expect(c.send({ externalChatId: '42', text: 'x', file: null, replyToExternalId: null })).rejects.toThrow(/заблокировал/);
    expect(calls).toHaveLength(1);
  });

  it('скачивание файла: повтор при сбое сети и 503', async () => {
    const { f, calls } = scripted([okJson({ file_path: 'docs/a.pdf', file_size: 3 }), 'net', new Response('busy', { status: 503 }), new Response(new Uint8Array([1, 2, 3]))]);
    const r = recorder();
    const c = new TelegramBotConnector('123:abc', { fetch: f, retry: r.retry });
    const got = await c.download('file-1', 1000);
    expect([...got.data]).toEqual([1, 2, 3]);
    expect(calls.map((x) => x.url.split('/').pop())).toEqual(['getFile', 'a.pdf', 'a.pdf', 'a.pdf']);
    expect(r.delays).toEqual([1000, 2000]);
  });

  it('getUpdates: сбой сети повторяется, канал не уходит в «ошибку»', async () => {
    let stop!: () => void;
    const stopped = new Promise<void>((res) => (stop = res));
    const statuses: string[] = [];
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      if (n === 2) return okJson([]);
      stop();
      return errJson(401);
    }) as unknown as typeof fetch;
    const c = new TelegramBotConnector('123:abc', { fetch: f, retry: recorder().retry });
    await c.start({ inbound: async () => undefined, status: async (s) => void statuses.push(s) });
    await stopped;
    await c.stop();
    expect(statuses[0]).toBe('connected');
    expect(statuses).not.toContain('starting');
    expect(statuses.slice(0, -1)).not.toContain('error');
  });

  it('остановка коннектора прерывает повторы', async () => {
    const ac = new AbortController();
    const { f, calls } = scripted(['net']);
    const api = new TelegramBotApi('123:abc', { fetch: f, retry: { sleep: async () => ac.abort(), random: () => 0.5 } });
    await expect(api.call('getUpdates', {}, 1000, ac.signal)).rejects.toBeInstanceOf(TelegramApiError);
    expect(calls).toHaveLength(1);
  });

  it('прокси берётся на момент запроса: после переключения запросы идут через запасной', async () => {
    const sw = new ProxySwitch(createMessengerProxy(PRIMARY), createMessengerProxy(FALLBACK));
    const { f, calls } = scripted([okJson({ message_id: 1 })]);
    const api = new TelegramBotApi('123:abc', { fetch: f, dispatcher: () => sw.current()?.dispatcher });
    await api.call('sendMessage', {});
    sw.use('fallback');
    await api.call('sendMessage', {});
    expect(calls[0]?.dispatcher).toBe(sw.primary?.dispatcher);
    expect(calls[1]?.dispatcher).toBe(sw.fallback?.dispatcher);
  });
});

/** Поддельный Baileys: каждый вызов makeSocket — новый сокет; end() закрывает его как настоящий. */
function fakeBaileys(over: Partial<WhatsAppDeps> = {}) {
  type Handlers = Map<string, (arg: unknown) => void>;
  const sockets: { config: Record<string, unknown>; handlers: Handlers; ended: unknown[]; ws: Handlers }[] = [];
  let stored: string | null = null;
  const loads: (string | null)[] = [];
  const events: string[] = [];
  const delays: number[] = [];
  const deps: WhatsAppDeps = {
    session: {
      load: async () => (loads.push(stored), stored),
      save: async (j) => void (stored = j),
      clear: async () => void (events.push('clear'), (stored = null)),
    },
    onQr: async (qr) => void events.push(qr ? `qr:${qr}` : 'qr:null'),
    onIdentity: async () => true,
    sleep: async (ms) => void delays.push(ms),
    makeSocket: ((config: Record<string, unknown>) => {
      const handlers: Handlers = new Map();
      const ws: Handlers = new Map();
      const ended: unknown[] = [];
      const s = {
        config,
        handlers,
        ended,
        ws,
      };
      sockets.push(s);
      return {
        ev: { on: (name: string, fn: (arg: unknown) => void) => void handlers.set(name, fn) },
        ws: { on: (name: string, fn: (arg: unknown) => void) => void ws.set(name, fn) },
        end: (err: unknown) => {
          ended.push(err);
          handlers.get('connection.update')?.({ connection: 'close', lastDisconnect: { error: err } });
        },
        logout: async () => undefined,
        user: { id: '79991234567:5@s.whatsapp.net' },
      };
    }) as unknown as WhatsAppDeps['makeSocket'],
    ...over,
  };
  return { deps, sockets, loads, events, delays, setStored: (j: string) => void (stored = j) };
}

const sinkOf = (statuses: string[]): ConnectorSink => ({ inbound: async () => undefined, status: async (s) => void statuses.push(s) });
const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

describe('WhatsApp: обрыв связи через прокси', () => {
  it('пауза переподключения растёт до 60 с', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(waReconnectDelayMs)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });

  it('обрыв (не loggedOut): переподключение с той же сессией, без сброса и без нового QR', async () => {
    const b = fakeBaileys();
    b.setStored('{"creds":{"me":{"id":"79991234567:5@s.whatsapp.net"}},"keys":{}}');
    const statuses: string[] = [];
    const c = new WhatsAppConnector(b.deps);
    await c.start(sinkOf(statuses));
    b.sockets[0]!.handlers.get('connection.update')!({ connection: 'open' });
    await until(() => statuses.includes('connected'));

    // Прокси оборвал соединение — Baileys закрывает сокет с connectionLost (408).
    for (let i = 0; i < 3; i++) {
      b.sockets.at(-1)!.handlers.get('connection.update')!({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
      await until(() => b.sockets.length === i + 2);
    }
    await c.stop();

    expect(b.delays).toEqual([2000, 4000, 8000]);
    expect(b.loads).toHaveLength(4);
    expect(new Set(b.loads)).toEqual(new Set([b.loads[0]]));
    expect(b.loads[0]).toContain('79991234567');
    expect(b.events).not.toContain('clear');
    expect(b.events.filter((e) => e.startsWith('qr:') && e !== 'qr:null')).toEqual([]);
    expect(statuses).toContain('no_phone');
    expect(statuses).not.toContain('session_ended');
  });

  it('loggedOut — единственный случай сброса сессии', async () => {
    const b = fakeBaileys();
    b.setStored('{"creds":{"me":{"id":"79991234567:5@s.whatsapp.net"}},"keys":{}}');
    const statuses: string[] = [];
    const c = new WhatsAppConnector(b.deps);
    await c.start(sinkOf(statuses));
    b.sockets[0]!.handlers.get('connection.update')!({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await until(() => statuses.includes('session_ended'));
    await c.stop();
    expect(b.events).toContain('clear');
    expect(b.sockets).toHaveLength(1);
  });

  it('прокси отказал в туннеле (HTTP 403): попытка обрывается и повторяется', async () => {
    const lines: string[] = [];
    const b = fakeBaileys({ log: (_l, m) => void lines.push(m) });
    const c = new WhatsAppConnector(b.deps);
    await c.start(sinkOf([]));
    (b.sockets[0]!.ws.get('unexpected-response') as unknown as (req: unknown, res: unknown) => void)({}, { statusCode: 403 });
    await until(() => b.sockets.length === 2);
    await c.stop();
    expect(b.sockets[0]!.ended).toHaveLength(1);
    expect(lines.join('\n')).toMatch(/HTTP 403/);
    expect(b.events).not.toContain('clear');
  });

  it('зависшее подключение без QR и без ответа обрывается по таймеру', async () => {
    const b = fakeBaileys({ connectWatchdogMs: 20 });
    const c = new WhatsAppConnector(b.deps);
    await c.start(sinkOf([]));
    await until(() => b.sockets.length === 2);
    await c.stop();
    expect(b.sockets[0]!.ended).toHaveLength(1);
  });

  it('QR пришёл — таймер не обрывает ожидание сканирования', async () => {
    const b = fakeBaileys({ connectWatchdogMs: 20 });
    const c = new WhatsAppConnector(b.deps);
    await c.start(sinkOf([]));
    b.sockets[0]!.handlers.get('connection.update')!({ qr: '2@abc' });
    await new Promise((r) => setTimeout(r, 60));
    await c.stop();
    expect(b.sockets).toHaveLength(1);
    // end(undefined) — это наша остановка в конце теста, не обрыв по таймеру.
    expect(b.sockets[0]!.ended.filter(Boolean)).toHaveLength(0);
  });

  it('новое подключение берёт текущий прокси (после переключения — запасной)', async () => {
    const sw = new ProxySwitch(createMessengerProxy(PRIMARY), createMessengerProxy(FALLBACK));
    const b = fakeBaileys({ proxy: () => sw.current() ?? undefined });
    const c = new WhatsAppConnector(b.deps);
    await c.start(sinkOf([]));
    sw.use('fallback');
    b.sockets[0]!.handlers.get('connection.update')!({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
    await until(() => b.sockets.length === 2);
    await c.stop();
    expect(b.sockets[0]!.config.agent).toBe(sw.primary?.agent);
    expect(b.sockets[1]!.config.agent).toBe(sw.fallback?.agent);
  });
});

/** Прокси «отвечает» по таблице: роль → очередь результатов. */
function probeBy(sw: ProxySwitch, primary: boolean[], fallback: boolean[] = []) {
  const seen: string[] = [];
  return {
    seen,
    probe: async (p: MessengerProxy) => {
      const isPrimary = p === sw.primary;
      seen.push(isPrimary ? 'primary' : 'fallback');
      const q = isPrimary ? primary : fallback;
      return { ok: (q.length > 1 ? q.shift() : q[0]) ?? true, latencyMs: 42 };
    },
  };
}

function memRedis() {
  const data = new Map<string, { v: string; ttl: number }>();
  return { data, set: async (k: string, v: string, _m: 'EX', ttl: number) => void data.set(k, { v, ttl }) };
}

describe('проверка прокси и запасной прокси', () => {
  it('прокси не задан — direct', async () => {
    const redis = memRedis();
    const m = new ProxyMonitor({ sw: new ProxySwitch(null), probe: async () => ({ ok: true, latencyMs: 1 }), redis, log: memLog });
    expect((await m.tick()).status).toBe('direct');
  });

  it('статус в Redis: ok/fail, время, задержка; без адреса, логина и пароля', async () => {
    const sw = new ProxySwitch(createMessengerProxy(PRIMARY));
    const redis = memRedis();
    const p = probeBy(sw, [true, false]);
    const m = new ProxyMonitor({ sw, probe: p.probe, redis, log: memLog, now: () => new Date('2026-11-04T18:00:00Z') });
    await m.tick();
    const saved = redis.data.get(PROXY_STATUS_KEY)!;
    expect(JSON.parse(saved.v)).toEqual({ status: 'ok', active: 'primary', checkedAt: '2026-11-04T18:00:00.000Z', latencyMs: 42, since: '2026-11-04T18:00:00.000Z' });
    expect(saved.ttl).toBe(300);
    expect((await m.tick()).status).toBe('fail');
    expect(saved.v + redis.data.get(PROXY_STATUS_KEY)!.v).not.toMatch(/user1|pr1m4ry|203\.0\.113/);
  });

  it('3 неудачи основного подряд — запасной; 3 удачи основного — обратно; в журнале без секретов', async () => {
    lines.length = 0;
    const sw = new ProxySwitch(createMessengerProxy(PRIMARY), createMessengerProxy(FALLBACK));
    const roles: string[] = [];
    sw.onChange((r) => roles.push(r));
    const p = probeBy(sw, [false, false, false, false, true, true, true, true], [true]);
    const m = new ProxyMonitor({ sw, probe: p.probe, redis: memRedis(), log: memLog });
    const got: ProxyStatus[] = [];
    for (let i = 0; i < 8; i++) got.push(await m.tick());

    expect(got.map((s) => `${s.active}:${s.status}`)).toEqual([
      'primary:fail',
      'primary:fail',
      'fallback:ok',
      'fallback:ok',
      'fallback:ok',
      'fallback:ok',
      'primary:ok',
      'primary:ok',
    ]);
    expect(roles).toEqual(['fallback', 'primary']);
    const log = lines.join('\n');
    expect(log).toMatch(/переключение на запасной/);
    expect(log).toMatch(/возврат на основной/);
    expect(log).not.toMatch(/user[12]|pr1m4ry|f4llb4ck|203\.0\.113|198\.51\.100/);
  });

  it('без запасного — переключения нет, статус fail', async () => {
    const sw = new ProxySwitch(createMessengerProxy(PRIMARY), null);
    const p = probeBy(sw, [false]);
    const m = new ProxyMonitor({ sw, probe: p.probe, redis: memRedis(), log: memLog });
    for (let i = 0; i < 5; i++) await m.tick();
    expect(sw.active).toBe('primary');
    expect(m.status?.status).toBe('fail');
    expect(p.seen.every((s) => s === 'primary')).toBe(true);
  });

  it('/health: статус из Redis, устаревший — stale, нет записи — unknown', () => {
    const s: ProxyStatus = { status: 'ok', active: 'primary', checkedAt: '2026-11-04T18:00:00.000Z', latencyMs: 40, since: '2026-11-04T18:00:00.000Z' };
    const at = Date.parse(s.checkedAt);
    expect(readProxyStatus(JSON.stringify(s), at + 60_000)).toEqual({ proxy: 'ok', proxyActive: 'primary', proxyCheckedAt: s.checkedAt, proxyLatencyMs: 40 });
    expect(readProxyStatus(JSON.stringify(s), at + 4 * 60_000).proxy).toBe('stale');
    expect(readProxyStatus(null).proxy).toBe('unknown');
    expect(readProxyStatus('{bad').proxy).toBe('unknown');
  });
});

const channel = (over: Partial<Channel>): Channel => ({
  id: 1,
  accountId: 1,
  kind: 'telegram_bot',
  title: '@rf_dveri_messenger_test_bot',
  externalId: '1',
  status: 'connected',
  statusDetail: null,
  credentials: '',
  createdAt: new Date(),
  ...over,
});

describe('уведомления о сбоях', () => {
  const T0 = Date.parse('2026-11-04T15:00:00Z');
  const MIN = 60_000;

  function notifier() {
    const sent: string[] = [];
    let now = T0;
    let fail = false;
    const n = new AlertNotifier({
      send: async (t) => {
        if (fail) throw new Error('нет связи');
        sent.push(t);
      },
      log: memLog,
      now: () => now,
    });
    return { n, sent, at: (min: number) => void (now = T0 + min * MIN), failSend: (v: boolean) => void (fail = v) };
  }

  it('проблемы: прокси fail; каналы Telegram/WhatsApp не connected; остальное не трогаем', () => {
    const proxy: ProxyStatus = { status: 'fail', active: 'fallback', checkedAt: '', latencyMs: 1, since: '' };
    const p = collectProblems(proxy, [
      channel({ id: 1 }),
      channel({ id: 3, kind: 'whatsapp', title: 'WhatsApp (ожидает QR)', status: 'starting', statusDetail: 'Отсканируйте QR-код' }),
      channel({ id: 5, kind: 'max' as Channel['kind'], status: 'error' }),
    ]);
    expect(p.map((x) => x.key)).toEqual(['proxy', 'channel:3']);
    expect(p[0]!.title).toMatch(/запасной/);
    expect(p[1]!.title).toBe('Канал «WhatsApp (ожидает QR)» (id 3, WhatsApp)');
    expect(p[1]!.detail).toBe('Статус: подключается — Отсканируйте QR-код');
    expect(collectProblems({ ...proxy, status: 'ok' }, [channel({})])).toEqual([]);
  });

  it('сбой дольше 5 мин — одно сообщение; восстановление — второе', async () => {
    const a = notifier();
    const pr = [{ key: 'channel:1', title: 'Канал «@bot» (id 1, Telegram-бот)', detail: 'Статус: ошибка — Нет связи с Telegram' }];
    for (const m of [0, 1, 4]) {
      a.at(m);
      await a.n.observe(pr);
    }
    expect(a.sent).toEqual([]);
    for (const m of [5, 6, 20]) {
      a.at(m);
      await a.n.observe(pr);
    }
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]).toContain('Канал «@bot» (id 1, Telegram-бот) не работает с 04.11, 18:00 МСК (5 мин)');
    expect(a.sent[0]).toContain('Нет связи с Telegram');
    a.at(25);
    await a.n.observe([]);
    expect(a.sent).toHaveLength(2);
    expect(a.sent[1]).toMatch(/снова работает\. Сбой с 04\.11, 18:00 МСК по 04\.11, 18:25 МСК \(25 мин\)/);
  });

  it('короткий сбой (до 5 мин) — без сообщений', async () => {
    const a = notifier();
    const pr = [{ key: 'proxy', title: 'Прокси', detail: '' }];
    a.at(0);
    await a.n.observe(pr);
    a.at(3);
    await a.n.observe([]);
    a.at(10);
    await a.n.observe([]);
    expect(a.sent).toEqual([]);
  });

  it('по одной проблеме — не чаще одного сообщения о сбое в 30 мин', async () => {
    const a = notifier();
    const pr = [{ key: 'proxy', title: 'Прокси', detail: '' }];
    const run = async (m: number, p: typeof pr) => (a.at(m), await a.n.observe(p));
    await run(0, pr);
    await run(6, pr); // сбой
    await run(10, []); // восстановление
    await run(11, pr);
    await run(18, pr); // снова сбой, но прошло 12 мин — молчим
    await run(37, pr); // 31 мин после первого — можно
    expect(a.sent.map((s) => (s.startsWith('✅') ? 'восстановлено' : 'сбой'))).toEqual(['сбой', 'восстановлено', 'сбой']);
  });

  it('сообщение не ушло — повтор на следующей проверке', async () => {
    const a = notifier();
    const pr = [{ key: 'proxy', title: 'Прокси', detail: '' }];
    a.at(0);
    await a.n.observe(pr);
    a.failSend(true);
    a.at(6);
    await a.n.observe(pr);
    a.failSend(false);
    a.at(7);
    await a.n.observe(pr);
    expect(a.sent).toHaveLength(1);
  });
});

describe('конфигурация: запасной прокси и уведомления', () => {
  const base = {
    PUBLIC_URL: 'https://chat.example.ru',
    DATABASE_URL: 'postgres://u:p@localhost/db',
    REDIS_URL: 'redis://localhost:6379',
    AMO_CLIENT_ID: '0c9f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
    AMO_CLIENT_SECRET: 'x'.repeat(20),
    ENCRYPTION_KEY: 'a'.repeat(64),
    FILE_URL_SECRET: 'b'.repeat(40),
  };

  it('новые переменные необязательны; пустые — прежнее поведение', () => {
    const env = loadEnv(base);
    expect(env.MESSENGER_PROXY_URL_FALLBACK).toBe('');
    expect(env.ALERT_TG_BOT_TOKEN).toBe('');
    expect(new ProxySwitch(createMessengerProxy(PRIMARY), createMessengerProxy(env.MESSENGER_PROXY_URL_FALLBACK)).use('fallback')).toBe(false);
  });

  it('запасной прокси — только http(s); токен и чат уведомлений задаются вместе', () => {
    expect(loadEnv({ ...base, MESSENGER_PROXY_URL_FALLBACK: FALLBACK }).MESSENGER_PROXY_URL_FALLBACK).toBe(FALLBACK);
    expect(() => loadEnv({ ...base, MESSENGER_PROXY_URL_FALLBACK: 'socks5://h:1' })).toThrow(/MESSENGER_PROXY_URL_FALLBACK/);
    expect(() => loadEnv({ ...base, ALERT_TG_BOT_TOKEN: '1:abc' })).toThrow(/вместе/);
    expect(loadEnv({ ...base, ALERT_TG_BOT_TOKEN: '1:abc', ALERT_TG_CHAT_ID: '-100' }).ALERT_TG_CHAT_ID).toBe('-100');
  });
});
