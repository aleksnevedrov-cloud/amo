import { AmoApiClient } from '@ai-door/amo';
import type { AmoAccess } from '../src/pipeline.ts';

export interface FakeAmoState {
  lead: Record<string, unknown> | null;
  events: { id: string; type: string; entity_id: number; created_by: number; created_at: number }[];
  calls: { method: string; path: string; body: unknown }[];
  sent: { returnUrl: string; messages: string[] }[];
  failSend?: boolean;
}

export function fakeAmo(overrides: Partial<FakeAmoState> = {}): { state: FakeAmoState; access: AmoAccess; send: (a: AmoAccess, u: string, m: string[]) => Promise<void> } {
  const state: FakeAmoState = {
    lead: { id: 100, name: 'Сделка', price: 0, status_id: 10, pipeline_id: 1, responsible_user_id: 3, created_at: 0, custom_fields_values: null, _embedded: { contacts: [] } },
    events: [],
    calls: [],
    sent: [],
    ...overrides,
  };
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    state.calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname.startsWith('/api/v4/leads/') && method === 'GET' && !url.pathname.endsWith('/notes')) {
      return state.lead ? json(state.lead) : new Response('', { status: 404 });
    }
    if (url.pathname === '/api/v4/events') return state.events.length ? json({ _embedded: { events: state.events } }) : new Response(null, { status: 204 });
    if (url.pathname.endsWith('/notes') && method === 'GET') return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/notes')) return json({ _embedded: { notes: [{ id: 1 }] } });
    if (url.pathname === '/api/v4/tasks') return json({ _embedded: { tasks: [{ id: 2 }] } });
    return json({});
  }) as typeof fetch;
  const access: AmoAccess = {
    api: new AmoApiClient('test.amocrm.ru', async () => 'T', f, async () => undefined),
    accessToken: async () => 'T',
    accountDomain: 'test.amocrm.ru',
  };
  const send = async (_a: AmoAccess, returnUrl: string, messages: string[]) => {
    if (state.failSend) throw new Error('continue failed');
    state.sent.push({ returnUrl, messages });
  };
  return { state, access, send };
}
