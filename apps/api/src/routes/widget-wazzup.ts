import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';
import type { WidgetPrincipal } from '@ai-door/amo';

const WAZZUP_API = 'https://api.wazzup24.com/v3';

/** Вкладка «Wazzup»: ключ API (только запись), проверка, подписка на вебхуки, статус. */
export function widgetWazzupRoutes(
  api: FastifyInstance,
  deps: Deps,
  principal: (req: FastifyRequest) => WidgetPrincipal,
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => boolean,
) {
  const webhookUri = (accountId: number) => new URL(`/wazzup/v1/webhook/${accountId}`, deps.env.PUBLIC_URL).toString();

  const call = async (apiKey: string, method: 'GET' | 'PATCH', path: string, body?: unknown) => {
    const res = await deps.fetch(`${WAZZUP_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text: text.slice(0, 300) };
  };

  api.get('/wazzup/status', async (req) => {
    const accountId = principal(req).accountId;
    const [hasKey, state, stats] = await Promise.all([
      deps.secrets.has(accountId, 'wazzup'),
      deps.wazzup.state(accountId),
      deps.wazzup.stats(accountId),
    ]);
    return { hasKey, webhookUri: webhookUri(accountId), state, stats };
  });

  // Ключ API Wazzup (или Sidecar-ключ интеграции amoCRM). Хранится шифрованно, обратно не отдаётся.
  api.put('/wazzup/key', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = z.object({ apiKey: z.string().min(8).max(500) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'no_key' });
    const p = principal(req);
    await deps.secrets.set(p.accountId, 'wazzup', b.data.apiKey.trim(), p.userId);
    // crmKey — наш секрет для проверки входящих вебхуков; создаётся один раз.
    if (!(await deps.secrets.has(p.accountId, 'wazzup_crm'))) {
      await deps.secrets.set(p.accountId, 'wazzup_crm', randomBytes(24).toString('hex'), p.userId);
    }
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: 'Ключ API Wazzup обновлён', details: { userId: p.userId } });
    return { ok: true };
  });

  // Проверка ключа: список каналов аккаунта Wazzup.
  api.post('/wazzup/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const accountId = principal(req).accountId;
    const apiKey = await deps.secrets.get(accountId, 'wazzup');
    if (!apiKey) return reply.code(400).send({ error: 'no_key' });
    const r = await call(apiKey, 'GET', '/channels');
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} ${r.text}` };
    const list = Array.isArray(r.json) ? (r.json as Array<{ channelId?: string; transport?: string; name?: string; plainId?: string; state?: string }>) : [];
    return { ok: true, channels: list.map((c) => ({ id: c.channelId ?? null, transport: c.transport ?? null, name: c.name ?? c.plainId ?? null, state: c.state ?? null })) };
  });

  // Подписка на вебхуки messagesAndStatuses. Wazzup шлёт проверочный POST {test:true} — приёмник отвечает 200.
  api.post('/wazzup/subscribe', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const p = principal(req);
    const [apiKey, crmKey] = await Promise.all([deps.secrets.get(p.accountId, 'wazzup'), deps.secrets.get(p.accountId, 'wazzup_crm')]);
    if (!apiKey || !crmKey) return reply.code(400).send({ error: 'no_key' });
    const uri = webhookUri(p.accountId);
    const r = await call(apiKey, 'PATCH', '/webhooks', {
      webhooksUri: uri,
      subscriptions: { messagesAndStatuses: true, contactsAndDealsCreation: false, channelsUpdates: false, templateStatus: false },
      crmKey,
    });
    if (!r.ok) {
      await deps.wazzup.markError(p.accountId, `подписка: HTTP ${r.status} ${r.text}`);
      return { ok: false, error: `HTTP ${r.status} ${r.text}` };
    }
    await deps.wazzup.markSubscribed(p.accountId, uri);
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `Wazzup: подписка на вебхуки оформлена (${uri})`, details: { userId: p.userId } });
    return { ok: true, webhookUri: uri };
  });

  // Текущая подписка на стороне Wazzup (что там стоит сейчас).
  api.get('/wazzup/subscription', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const apiKey = await deps.secrets.get(principal(req).accountId, 'wazzup');
    if (!apiKey) return reply.code(400).send({ error: 'no_key' });
    const r = await call(apiKey, 'GET', '/webhooks');
    return r.ok ? { ok: true, current: r.json } : { ok: false, error: `HTTP ${r.status} ${r.text}` };
  });
}
