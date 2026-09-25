import { randomBytes } from 'node:crypto';
import { AmoApiClient } from '@ai-door/amo';
import { AccountsRepo, DialogRepo, JournalRepo, SettingsRepo, widgetSettingsSchema, type Db, type WidgetSettingsInput } from '@ai-door/db';
import { SecretBox } from '@ai-door/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from '../../db/test/setup.ts';
import { composeRaw, EmailChannel, MailRepo, pollMailbox, type Mailbox, type OutgoingEmail, type PollDeps } from '../src/index.ts';

/** Ящик в памяти: папки с письмами по UID. */
class FakeMailbox implements Mailbox {
  folders = new Map<string, { uidValidity: string; msgs: { uid: number; source: Buffer }[] }>([
    ['INBOX', { uidValidity: '1', msgs: [] }],
    ['Отправленные', { uidValidity: '1', msgs: [] }],
  ]);
  appended: { folder: string; raw: Buffer }[] = [];
  async folderState(folder: string) {
    const f = this.folders.get(folder)!;
    return { uidValidity: f.uidValidity, maxUid: f.msgs.at(-1)?.uid ?? 0 };
  }
  async fetchAfter(folder: string, after: number, limit: number) {
    return this.folders.get(folder)!.msgs.filter((m) => m.uid > after).slice(0, limit);
  }
  async findSentFolder() {
    return 'Отправленные';
  }
  async append(folder: string, raw: Buffer) {
    this.appended.push({ folder, raw });
  }
  async close() {}
  async put(folder: string, mail: Partial<OutgoingEmail>) {
    const f = this.folders.get(folder)!;
    const uid = (f.msgs.at(-1)?.uid ?? 0) + 1;
    f.msgs.push({
      uid,
      source: await composeRaw({
        from: { name: 'Иван', address: 'ivan@client.ru' },
        to: { name: '', address: 'shop@rf-dveri.ru' },
        subject: 'Двери',
        text: 'Нужны двери',
        html: '',
        messageId: `<m${uid}.${folder.length}@client.ru>`,
        headers: {},
        ...mail,
      }),
    });
  }
}

let db: Db;
let drop: () => Promise<void>;
const box = new SecretBox(randomBytes(32).toString('hex'));
let mail: MailRepo;

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await new AccountsRepo(db).upsertInstalled({ id: 1, subdomain: 'a', accountDomain: 'a.amocrm.ru' });
  mail = new MailRepo(db, box);
  await mail.setPassword(1, 'secret', 1);
});
afterAll(async () => drop());

interface AmoCall {
  method: string;
  path: string;
  body: unknown;
}

function fakeAmo(opts: { contacts?: unknown[]; leads?: unknown[] } = {}) {
  const calls: AmoCall[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname === '/api/v4/contacts') return opts.contacts?.length ? json({ _embedded: { contacts: opts.contacts } }) : new Response(null, { status: 204 });
    if (url.pathname === '/api/v4/leads' && method === 'GET') return json({ _embedded: { leads: opts.leads ?? [] } });
    if (url.pathname === '/api/v4/leads/complex') return json([{ id: 501, contact_id: 601 }]);
    if (url.pathname === '/api/v4/leads' && method === 'POST') return json({ _embedded: { leads: [{ id: 502 }] } });
    if (url.pathname === '/api/v4/leads/pipelines') {
      return json({ _embedded: { pipelines: [{ id: 1, name: 'Продажи', _embedded: { statuses: [{ id: 11, name: 'Неразобранное', type: 1 }, { id: 10, name: 'Первичный контакт', type: 0 }] } }] } });
    }
    if (url.pathname.endsWith('/notes')) return json({ _embedded: { notes: [{ id: 1 }] } });
    return json({});
  }) as typeof fetch;
  return { calls, api: new AmoApiClient('a.amocrm.ru', async () => 'T', f, async () => undefined) };
}

const EMAIL = { enabled: true, imapHost: 'imap.yandex.ru', smtpHost: 'smtp.yandex.ru', username: 'shop@rf-dveri.ru' };

async function setup(email: WidgetSettingsInput['email'] = {}, amoOpts: Parameters<typeof fakeAmo>[0] = {}) {
  await new SettingsRepo(db).save(1, 1, widgetSettingsSchema.parse({ enabled: true, mode: 'auto', email: { ...EMAIL, ...email } }));
  const mb = new FakeMailbox();
  const amo = fakeAmo(amoOpts);
  const scheduled: unknown[] = [];
  const deps: PollDeps = {
    settings: new SettingsRepo(db),
    mail,
    dialog: new DialogRepo(db),
    journal: new JournalRepo(db),
    amo: async () => amo.api,
    connect: async () => mb,
    schedule: async (job, w) => void scheduled.push([job, w]),
  };
  // Первый проход только запоминает позицию.
  await db.query('DELETE FROM mailbox_state');
  await mb.put('INBOX', { subject: 'Старое письмо' });
  expect(await pollMailbox(1, deps)).toMatchObject({ received: 0 });
  return { mb, amo, scheduled, deps };
}

const knownContact = {
  contacts: [{ id: 77, name: 'Иван', custom_fields_values: [{ field_id: 1, field_code: 'EMAIL', values: [{ value: 'IVAN@client.ru' }] }], _embedded: { leads: [{ id: 300 }, { id: 301 }] } }],
  leads: [
    { id: 300, status_id: 142, pipeline_id: 1 },
    { id: 301, status_id: 10, pipeline_id: 1 },
  ],
};

beforeEach(async () => {
  await db.query('DELETE FROM pending_messages');
  await db.query('DELETE FROM email_outbound');
});

describe('pollMailbox', () => {
  it('первый запуск не обрабатывает старые письма; новое письмо известного клиента — в его открытую сделку', async () => {
    const t = await setup({}, knownContact);
    await t.mb.put('INBOX', { subject: 'Двери в квартиру', text: 'Нужны 3 белые двери' });
    const r = await pollMailbox(1, t.deps);
    expect(r).toMatchObject({ received: 1, queued: 1 });
    const pending = await new DialogRepo(db).takePending(1, 301);
    expect(pending[0]).toMatchObject({ channel: 'email', meta: { from: 'ivan@client.ru', subject: 'Двери в квартиру' } });
    expect(pending[0]?.text).toContain('Тема письма: Двери в квартиру\nНужны 3 белые двери');
    expect(t.scheduled).toEqual([[{ accountId: 1, leadId: 301 }, 8000]]);
    // Повторный проход ничего не берёт.
    expect(await pollMailbox(1, t.deps)).toMatchObject({ received: 0 });
  });

  it('неизвестный отправитель — контакт и сделка в выбранной воронке', async () => {
    const t = await setup({ unknownSender: 'create_lead', newLeadPipelineId: 5, newLeadStatusId: 55 });
    await t.mb.put('INBOX', { from: { name: 'Ольга', address: 'olga@new.ru' }, subject: 'Входная дверь' });
    expect(await pollMailbox(1, t.deps)).toMatchObject({ queued: 1 });
    const complex = t.amo.calls.find((c) => c.path === '/api/v4/leads/complex');
    expect(complex?.body).toEqual([
      {
        name: 'Письмо: Входная дверь',
        pipeline_id: 5,
        status_id: 55,
        _embedded: { contacts: [{ name: 'Ольга', custom_fields_values: [{ field_code: 'EMAIL', values: [{ value: 'olga@new.ru', enum_code: 'WORK' }] }] }] },
      },
    ]);
  });

  it('режим «пропускать неизвестных»', async () => {
    const t = await setup({ unknownSender: 'skip' });
    await t.mb.put('INBOX', { from: { name: '', address: 'x@new.ru' } });
    expect(await pollMailbox(1, t.deps)).toMatchObject({ queued: 0, skipped: 1 });
  });

  it('автоответы, noreply, исключения и собственный адрес — без ответа', async () => {
    const t = await setup({ ignore: ['supplier.ru'] }, knownContact);
    await t.mb.put('INBOX', { headers: { 'Auto-Submitted': 'auto-replied' } });
    await t.mb.put('INBOX', { from: { name: '', address: 'noreply@bank.ru' } });
    await t.mb.put('INBOX', { from: { name: '', address: 'sales@supplier.ru' } });
    await t.mb.put('INBOX', { from: { name: '', address: 'shop@rf-dveri.ru' } });
    expect(await pollMailbox(1, t.deps)).toMatchObject({ received: 4, queued: 0, skipped: 4 });
    expect(t.amo.calls).toHaveLength(0);
  });

  it('лимит ответов на адрес за сутки', async () => {
    const t = await setup({ maxRepliesPerAddressPerDay: 1 }, knownContact);
    await mail.logOutbound(1, 301, 'ivan@client.ru', '<x@rf-dveri.ru>');
    await t.mb.put('INBOX', {});
    expect(await pollMailbox(1, t.deps)).toMatchObject({ queued: 0, skipped: 1 });
  });

  it('письмо менеджера в «Отправленных» фиксируется, письмо AI — нет', async () => {
    const t = await setup({}, knownContact);
    await pollMailbox(1, t.deps); // позиция «Отправленных»
    const since = new Date(Date.now() - 60_000);
    await t.mb.put('Отправленные', { from: { name: '', address: 'shop@rf-dveri.ru' }, to: { name: '', address: 'ai-client@x.ru' }, headers: { 'X-AI-Door': '1' } });
    await t.mb.put('Отправленные', { from: { name: '', address: 'shop@rf-dveri.ru' }, to: { name: '', address: 'ivan@client.ru' } });
    expect(await pollMailbox(1, t.deps)).toMatchObject({ managerReplies: 1 });
    expect(await mail.managerRepliedSince(1, ['ivan@client.ru'], since)).toBe(true);
    expect(await mail.managerRepliedSince(1, ['ai-client@x.ru'], since)).toBe(false);
  });

  it('смена UIDVALIDITY — позиция сбрасывается без обработки', async () => {
    const t = await setup({}, knownContact);
    t.mb.folders.get('INBOX')!.uidValidity = '2';
    await t.mb.put('INBOX', {});
    expect(await pollMailbox(1, t.deps)).toMatchObject({ received: 0 });
  });

  it('ошибка подключения сохраняется для статуса', async () => {
    const t = await setup();
    t.deps.connect = async () => {
      throw new Error('AUTHENTICATIONFAILED');
    };
    expect((await pollMailbox(1, t.deps)).error).toBe('AUTHENTICATIONFAILED');
    expect((await mail.status(1)).find((x) => x.folder === 'INBOX')?.lastError).toBe('AUTHENTICATIONFAILED');
  });

  it('выключенная почта или нет пароля — ничего не делает', async () => {
    await new SettingsRepo(db).save(1, 1, widgetSettingsSchema.parse({ email: { ...EMAIL, enabled: false } }));
    let connected = false;
    const deps = { ...(await setup()).deps, connect: async () => ((connected = true), new FakeMailbox()) };
    await new SettingsRepo(db).save(1, 1, widgetSettingsSchema.parse({ email: { ...EMAIL, enabled: false } }));
    await pollMailbox(1, deps);
    expect(connected).toBe(false);
  });
});

describe('почта уже подключена к amo: ждём сделку от amo', () => {
  beforeEach(async () => {
    await db.query('DELETE FROM email_waiting');
  });

  it('новый адрес: ждём, пока amo создаст заявку и менеджер примет её в работу', async () => {
    const amoState: { contacts?: unknown[]; leads?: unknown[] } = {};
    const t = await setup({}, amoState);
    await t.mb.put('INBOX', { from: { name: 'Ольга', address: 'olga@new.ru' }, subject: 'Входная дверь' });
    expect(await pollMailbox(1, t.deps)).toMatchObject({ received: 1, waiting: 1, queued: 0 });
    expect(t.amo.calls.some((c) => c.path.includes('/leads/complex'))).toBe(false);

    // Пока amo не создал сделку — письмо ждёт.
    expect(await pollMailbox(1, t.deps)).toMatchObject({ queued: 0 });
    // Почта amo создала заявку в «Неразобранном» — это ещё не сделка, AI ждёт.
    amoState.contacts = [{ id: 90, name: 'Ольга', custom_fields_values: [{ field_id: 1, field_code: 'EMAIL', values: [{ value: 'olga@new.ru' }] }], _embedded: { leads: [{ id: 700 }] } }];
    amoState.leads = [{ id: 700, status_id: 11, pipeline_id: 1 }];
    expect(await pollMailbox(1, t.deps)).toMatchObject({ queued: 0 });
    // Менеджер принял заявку — AI отвечает в сделке.
    amoState.leads = [{ id: 700, status_id: 10, pipeline_id: 1 }];
    expect(await pollMailbox(1, t.deps)).toMatchObject({ queued: 1 });
    const pending = await new DialogRepo(db).takePending(1, 700);
    expect(pending[0]).toMatchObject({ channel: 'email', meta: { from: 'olga@new.ru', subject: 'Входная дверь' } });
    expect(await mail.listWaiting(1)).toEqual([]);
  });

  it('amo не создал сделку за отведённое время — письмо пропускается', async () => {
    const t = await setup({ waitForAmoMin: 1 });
    await t.mb.put('INBOX', { from: { name: '', address: 'late@new.ru' } });
    await pollMailbox(1, t.deps);
    await db.query(`UPDATE email_waiting SET received_at = now() - interval '5 minutes'`);
    expect(await pollMailbox(1, t.deps)).toMatchObject({ skipped: 1, queued: 0 });
    expect(await mail.listWaiting(1)).toEqual([]);
  });

  it('по истечении ожидания можно создать сделку самим', async () => {
    const t = await setup({ waitForAmoMin: 1, afterWait: 'create_lead' });
    await t.mb.put('INBOX', { from: { name: 'Пётр', address: 'petr@new.ru' } });
    await pollMailbox(1, t.deps);
    await db.query(`UPDATE email_waiting SET received_at = now() - interval '5 minutes'`);
    expect(await pollMailbox(1, t.deps)).toMatchObject({ queued: 1 });
    expect(t.amo.calls.some((c) => c.path === '/api/v4/leads/complex')).toBe(true);
  });
});

describe('EmailChannel', () => {
  it('отвечает в цепочку, кладёт копию в «Отправленные», пишет примечание и журнал отправки', async () => {
    await new SettingsRepo(db).save(1, 1, widgetSettingsSchema.parse({ email: { ...EMAIL, fromName: 'РФ-Двери', noteInLead: true } }));
    const mb = new FakeMailbox();
    const amo = fakeAmo();
    const sent: OutgoingEmail[] = [];
    const ch = new EmailChannel({
      settings: new SettingsRepo(db),
      mail,
      amo: async () => amo.api,
      connect: async () => mb,
      sender: () => ({ send: async (m) => (sent.push(m), composeRaw(m)), verify: async () => undefined }),
    });
    const { messageId } = await ch.reply(1, 301, { from: 'ivan@client.ru', fromName: 'Иван', subject: 'Двери', messageId: '<m1@client.ru>', references: [] }, 'Подойдёт Турин 1.');
    expect(sent[0]).toMatchObject({
      from: { name: 'РФ-Двери', address: 'shop@rf-dveri.ru' },
      to: { address: 'ivan@client.ru' },
      subject: 'Re: Двери',
      inReplyTo: '<m1@client.ru>',
      headers: { 'X-AI-Door': '1' },
    });
    expect(mb.appended[0]?.folder).toBe('Отправленные');
    expect(await mail.isOurMessage(1, messageId)).toBe(true);
    expect(amo.calls.some((c) => c.path === '/api/v4/leads/301/notes')).toBe(true);
  });

  it('без примечания, если почта подключена к amo (по умолчанию)', async () => {
    await new SettingsRepo(db).save(1, 1, widgetSettingsSchema.parse({ email: EMAIL }));
    const amo = fakeAmo();
    const ch = new EmailChannel({
      settings: new SettingsRepo(db),
      mail,
      amo: async () => amo.api,
      connect: async () => new FakeMailbox(),
      sender: () => ({ send: async (m) => composeRaw(m), verify: async () => undefined }),
    });
    await ch.reply(1, 302, { from: 'ivan@client.ru', subject: 'Двери' }, 'Ответ');
    expect(amo.calls).toHaveLength(0);
  });

  it('без пароля или при выключенной почте — ошибка', async () => {
    await new SettingsRepo(db).save(1, 1, widgetSettingsSchema.parse({ email: { ...EMAIL, enabled: false } }));
    const ch = new EmailChannel({
      settings: new SettingsRepo(db),
      mail,
      amo: async () => fakeAmo().api,
      connect: async () => new FakeMailbox(),
      sender: () => ({ send: async () => Buffer.from(''), verify: async () => undefined }),
    });
    await expect(ch.reply(1, 1, { from: 'a@b.ru' }, 'x')).rejects.toThrow(/не подключена/);
  });
});
