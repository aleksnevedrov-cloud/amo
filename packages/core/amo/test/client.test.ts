import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { AmoApiClient, fieldValues } from '../src/client.ts';
import { continueBot, isSafeReturnUrl, verifyBotToken } from '../src/salesbot.ts';

function scripted(responses: { status: number; body?: unknown }[]) {
  const calls: { url: string; method: string; body: unknown; auth: string | null }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : 'bytes') : undefined,
      auth: new Headers(init?.headers).get('authorization'),
    });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
  return { fn, calls };
}

const client = (f: typeof fetch) => new AmoApiClient('acc.amocrm.ru', async () => 'TOKEN', f, async () => undefined);

describe('AmoApiClient', () => {
  it('получает сделку с контактами, 404 → null', async () => {
    const s = scripted([{ status: 200, body: { id: 5, name: 'Сделка' } }, { status: 404 }]);
    expect(await client(s.fn).getLead(5)).toMatchObject({ id: 5 });
    expect(await client(s.fn).getLead(6)).toBeNull();
    expect(s.calls[0]).toMatchObject({ url: 'https://acc.amocrm.ru/api/v4/leads/5?with=contacts', auth: 'Bearer TOKEN' });
  });

  it('повторяет запрос при 429', async () => {
    const s = scripted([{ status: 429 }, { status: 429 }, { status: 200, body: { id: 1, name: 'x', subdomain: 'acc' } }]);
    expect(await client(s.fn).getAccount()).toMatchObject({ id: 1 });
    expect(s.calls).toHaveLength(3);
  });

  it('204 на пустой список событий', async () => {
    const s = scripted([{ status: 204 }]);
    expect(await client(s.fn).getOutgoingChatEvents(5, new Date(1_700_000_000_000))).toEqual([]);
    const url = new URL(s.calls[0]!.url);
    expect(url.searchParams.get('filter[type]')).toBe('outgoing_chat_message');
    expect(url.searchParams.get('filter[created_at][from]')).toBe('1700000000');
  });

  it('создаёт примечание, задачу и меняет этап', async () => {
    const s = scripted([
      { status: 200, body: { _embedded: { notes: [{ id: 11 }] } } },
      { status: 200, body: { _embedded: { tasks: [{ id: 22 }] } } },
      { status: 200, body: {} },
    ]);
    const c = client(s.fn);
    expect(await c.addLeadNote(5, 'Резюме')).toBe(11);
    expect(await c.createTask({ text: 'Связаться', completeTill: new Date(1_700_000_000_000), leadId: 5, taskTypeId: 1 })).toBe(22);
    await c.setLeadStatus(5, 777);
    expect(s.calls[0]).toMatchObject({ method: 'POST', body: [{ note_type: 'common', params: { text: 'Резюме' } }] });
    expect(s.calls[1]?.body).toEqual([
      { text: 'Связаться', complete_till: 1_700_000_000, entity_id: 5, entity_type: 'leads', task_type_id: 1 },
    ]);
    expect(s.calls[2]).toMatchObject({ method: 'PATCH', body: { status_id: 777 } });
  });

  it('ошибка сервера пробрасывается', async () => {
    const s = scripted([{ status: 500 }]);
    await expect(client(s.fn).addLeadNote(1, 'x')).rejects.toThrow(/HTTP 500/);
  });

  it('fieldValues по коду поля', () => {
    const fields = [{ field_id: 1, field_code: 'PHONE', values: [{ value: '+79161234567' }] }];
    expect(fieldValues(fields, 'PHONE')).toEqual(['+79161234567']);
    expect(fieldValues(null, 'EMAIL')).toEqual([]);
  });
});

describe('Salesbot', () => {
  const secret = 'client-secret-0123456789abcdef';
  const sign = (alg: string, key = secret, claims: Record<string, unknown> = { account_id: 31337, subdomain: 'acc' }) =>
    new SignJWT(claims).setProtectedHeader({ alg }).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(key));

  it('принимает токен HS512 и отвергает остальные', async () => {
    await expect(verifyBotToken(await sign('HS512'), { clientSecret: secret })).resolves.toMatchObject({ accountId: 31337 });
    await expect(verifyBotToken(await sign('HS256'), { clientSecret: secret })).rejects.toThrow();
    await expect(verifyBotToken(await sign('HS512', 'x'.repeat(32)), { clientSecret: secret })).rejects.toThrow();
    await expect(verifyBotToken(await sign('HS512', secret, {}), { clientSecret: secret })).rejects.toThrow(/account_id/);
  });

  it('return_url только на домен аккаунта по https', () => {
    expect(isSafeReturnUrl('https://acc.amocrm.ru/api/v4/salesbot/1/continue/2', 'acc.amocrm.ru')).toBe(true);
    expect(isSafeReturnUrl('https://evil.com/continue', 'acc.amocrm.ru')).toBe(false);
    expect(isSafeReturnUrl('http://acc.amocrm.ru/x', 'acc.amocrm.ru')).toBe(false);
  });

  it('continue отдаёт текст через data.reply (show ограничен 80 символами)', async () => {
    const s = scripted([{ status: 200 }]);
    await continueBot('https://acc.amocrm.ru/c', 'TOKEN', ['Привет', 'Вот модели'], s.fn);
    expect(s.calls[0]).toMatchObject({
      auth: 'Bearer TOKEN',
      body: {
        data: { status: 'success', reply: 'Привет\n\nВот модели', has_reply: '1' },
      },
    });
    expect((s.calls[0]?.body as { execute_handlers?: unknown }).execute_handlers).toBeUndefined();
  });
});

describe('AmoApiClient: файлы сделки (для «Агента опт»)', () => {
  it('список файлов: uuid из списка, карточка файла — отдельным запросом; скачивание по ссылке из карточки с Bearer', async () => {
    const s = scripted([
      { status: 200, body: { _embedded: { files: [{ file_uuid: 'aaa' }, { file_uuid: 'bbb', file: { uuid: 'bbb', name: 'Двери (3).docx', size: 1234, created_at: 1_700_000_000, metadata: { mime_type: 'application/msword', extension: 'docx' }, _links: { download: { href: 'https://drive-b.amocrm.ru/download/bbb' } } } }] } } },
      { status: 200, body: { drive_url: 'https://drive-b.amocrm.ru' } },
      { status: 404 },
      { status: 404 },
    ]);
    const files = await client(s.fn).listLeadFiles(5);
    expect(s.calls.map((c) => c.url)).toEqual(['https://acc.amocrm.ru/api/v4/leads/5/files?limit=20', 'https://acc.amocrm.ru/api/v4/account?with=drive_url', 'https://drive-b.amocrm.ru/v1.0/files/aaa', 'https://acc.amocrm.ru/api/v4/files/aaa']);
    // Файл без карточки (404) пропускается, а не роняет список.
    expect(files).toEqual([{ uuid: 'bbb', name: 'Двери (3).docx', size: 1234, mime: 'application/msword', createdAt: new Date(1_700_000_000_000), downloadUrl: 'https://drive-b.amocrm.ru/download/bbb' }]);

    const calls: { url: string; auth: string | null }[] = [];
    const dl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return new Response(new Uint8Array([80, 75]), { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document; charset=binary' } });
    }) as typeof fetch;
    const got = await client(dl).downloadFile(files[0]!);
    expect(calls).toEqual([{ url: 'https://drive-b.amocrm.ru/download/bbb', auth: 'Bearer TOKEN' }]);
    expect([...got.bytes]).toEqual([80, 75]);
    expect(got.mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('реальный формат /leads/{id}/files — только id и file_uuid: карточка файла с drive-url, файл находится по имени без учёта регистра (RFD-AI-AGENT-FIX-PACK-2410, ч. 3)', async () => {
    const s = scripted([
      { status: 200, body: { _embedded: { files: [{ id: 8870246, file_uuid: '0c3b84c5-50bf-442a-b9a2-668b0dfd52cb' }, { id: 8870094, file_uuid: '5fb0943d-f045-4edf-897d-a87cc3118b12' }] } } },
      { status: 200, body: { drive_url: 'https://drive-b.amocrm.ru/' } },
      { status: 200, body: { uuid: '0c3b84c5-50bf-442a-b9a2-668b0dfd52cb', name: 'Запрос.docx', size: 20480, metadata: { mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx' }, _links: { download: { href: 'https://drive-b.amocrm.ru/download/0c3b84c5' } } } },
      { status: 200, body: { uuid: '5fb0943d-f045-4edf-897d-a87cc3118b12', name: 'IMG_0012.jpg', size: 300, metadata: { mime_type: 'image/jpeg', extension: 'jpg' }, _links: { download: { href: 'https://drive-b.amocrm.ru/download/5fb0943d' } } } },
    ]);
    const files = await client(s.fn).listLeadFiles(29207977, 100);
    expect(s.calls.map((c) => c.url)).toEqual(['https://acc.amocrm.ru/api/v4/leads/29207977/files?limit=100', 'https://acc.amocrm.ru/api/v4/account?with=drive_url', 'https://drive-b.amocrm.ru/v1.0/files/0c3b84c5-50bf-442a-b9a2-668b0dfd52cb', 'https://drive-b.amocrm.ru/v1.0/files/5fb0943d-f045-4edf-897d-a87cc3118b12']);
    expect(files.map((f) => [f.name, f.mime, f.downloadUrl])).toEqual([['Запрос.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'https://drive-b.amocrm.ru/download/0c3b84c5'], ['IMG_0012.jpg', 'image/jpeg', 'https://drive-b.amocrm.ru/download/5fb0943d']]);
    expect(files.filter((f) => f.name.toLowerCase().includes('запрос'.toLowerCase())).map((f) => f.uuid)).toEqual(['0c3b84c5-50bf-442a-b9a2-668b0dfd52cb']);
  });

  it('204 на пустой список файлов → []', async () => {
    const s = scripted([{ status: 204 }]);
    expect(await client(s.fn).listLeadFiles(5)).toEqual([]);
  });

  it('загрузка файла: сессия на drive_url из /api/v4/account, части по upload_url, привязка к сделке; drive_url кэшируется', async () => {
    const s = scripted([
      { status: 200, body: { id: 1, drive_url: 'https://drive-b.amocrm.ru/' } },
      { status: 200, body: { upload_url: 'https://drive-b.amocrm.ru/upload/1', max_part_size: 4 } },
      { status: 200, body: { next_url: 'https://drive-b.amocrm.ru/upload/2' } },
      { status: 200, body: { uuid: 'f-1' } },
      { status: 200, body: {} },
      // Второй файл: аккаунт не запрашивается заново.
      { status: 200, body: { upload_url: 'https://drive-b.amocrm.ru/upload/9', max_part_size: 100 } },
      { status: 200, body: { uuid: 'f-2' } },
      { status: 200, body: {} },
    ]);
    const c = client(s.fn);
    expect(await c.uploadFileToLead(7, { filename: 'Карточка.doc', mime: 'application/msword', bytes: new Uint8Array([1, 2, 3, 4, 5, 6]) })).toBe('f-1');
    expect(s.calls.map((x) => [x.method, x.url])).toEqual([
      ['GET', 'https://acc.amocrm.ru/api/v4/account?with=drive_url'],
      ['POST', 'https://drive-b.amocrm.ru/v1.0/sessions'],
      ['POST', 'https://drive-b.amocrm.ru/upload/1'],
      ['POST', 'https://drive-b.amocrm.ru/upload/2'],
      ['PUT', 'https://acc.amocrm.ru/api/v4/leads/7/files'],
    ]);
    expect(s.calls[1]?.body).toEqual({ file_name: 'Карточка.doc', file_size: 6, content_type: 'application/msword', with_preview: false });
    expect(s.calls[1]?.auth).toBe('Bearer TOKEN');
    expect(s.calls[4]?.body).toEqual([{ file_uuid: 'f-1' }]);
    expect(await c.uploadFileToLead(7, { filename: 'b.pdf', mime: 'application/pdf', bytes: new Uint8Array([1]) })).toBe('f-2');
    expect(s.calls[5]?.url).toBe('https://drive-b.amocrm.ru/v1.0/sessions');
  });

  it('загрузка файла: ошибка amo — в тексте URL, код и тело ответа; без drive_url — старый путь на домене аккаунта с пометкой', async () => {
    const s = scripted([
      { status: 200, body: { id: 1, drive_url: 'https://drive-b.amocrm.ru' } },
      { status: 403, body: { title: 'Forbidden', detail: 'Scope files is required' } },
    ]);
    await expect(client(s.fn).uploadFileToLead(7, { filename: 'a.doc', mime: '', bytes: new Uint8Array([1]) })).rejects.toThrow(
      'сессия загрузки файла в amo: POST https://drive-b.amocrm.ru/v1.0/sessions → HTTP 403: {"title":"Forbidden","detail":"Scope files is required"}',
    );
    const old = scripted([{ status: 200, body: { id: 1 } }, { status: 404, body: {} }]);
    await expect(client(old.fn).uploadFileToLead(7, { filename: 'a.doc', mime: '', bytes: new Uint8Array([1]) })).rejects.toThrow(
      'сессия загрузки файла в amo: POST https://acc.amocrm.ru/api/v4/files/sessions → HTTP 404: {} (drive_url в /api/v4/account не получен)',
    );
    expect(old.calls[1]?.url).toBe('https://acc.amocrm.ru/api/v4/files/sessions');
    // Привязка: файл уже на drive, PUT отвечает 405 — ошибка с адресом, кодом и телом.
    const link = scripted([
      { status: 200, body: { id: 1, drive_url: 'https://drive-b.amocrm.ru' } },
      { status: 200, body: { upload_url: 'https://drive-b.amocrm.ru/upload/1', max_part_size: 100 } },
      { status: 200, body: { uuid: 'f-9' } },
      { status: 405, body: { title: 'Method Not Allowed' } },
    ]);
    await expect(client(link.fn).uploadFileToLead(7, { filename: 'a.doc', mime: '', bytes: new Uint8Array([1]) })).rejects.toThrow(
      'привязка файла f-9 к сделке: PUT https://acc.amocrm.ru/api/v4/leads/7/files → HTTP 405: {"title":"Method Not Allowed"}',
    );
    expect(link.calls[3]).toMatchObject({ method: 'PUT', url: 'https://acc.amocrm.ru/api/v4/leads/7/files', body: [{ file_uuid: 'f-9' }] });
  });
});
