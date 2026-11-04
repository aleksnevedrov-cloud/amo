import { initAuthCreds, type WAMessage } from 'baileys';
import { describe, expect, it } from 'vitest';
import { createDbAuthState } from '../src/connectors/wa-auth.ts';
import { normalizeWaMessage } from '../src/connectors/whatsapp.ts';
import { validateChannel } from '../src/channels.ts';

const NOW = 1_800_000_000;
const msg = (over: Partial<WAMessage> & { message?: WAMessage['message'] }): WAMessage =>
  ({
    key: { remoteJid: '79991234567@s.whatsapp.net', id: 'ABC1', fromMe: false },
    messageTimestamp: NOW - 5,
    pushName: 'Иван',
    message: { conversation: 'Здравствуйте' },
    ...over,
  }) as WAMessage;

describe('WhatsApp: разбор сообщений', () => {
  it('личное текстовое: номер клиента, имя, без автора', () => {
    const ev = normalizeWaMessage(msg({}), { now: NOW });
    expect(ev).toMatchObject({
      externalChatId: '79991234567@s.whatsapp.net',
      chatTitle: 'Иван',
      isGroup: false,
      contact: { phone: '+79991234567' },
      author: null,
      externalMessageId: 'ABC1',
      text: 'Здравствуйте',
      attachment: null,
      fromMe: false,
    });
  });

  it('номер из remoteJidAlt, если чат адресован через lid', () => {
    const ev = normalizeWaMessage(msg({ key: { remoteJid: '123456789@lid', id: 'L1', fromMe: false, remoteJidAlt: '79990001122@s.whatsapp.net' } as WAMessage['key'] }), { now: NOW });
    expect(ev?.contact.phone).toBe('+79990001122');
    expect(ev?.externalChatId).toBe('123456789@lid');
  });

  it('фото с подписью, голосовое, документ, ответ с цитатой', () => {
    const photo = normalizeWaMessage(msg({ message: { imageMessage: { caption: 'Вот проём', mimetype: 'image/jpeg', contextInfo: { stanzaId: 'Q1' } } } }), { now: NOW });
    expect(photo?.text).toBe('Вот проём');
    expect(photo?.attachment).toMatchObject({ kind: 'picture', ref: 'ABC1', mime: 'image/jpeg' });
    expect(photo?.replyToExternalId).toBe('Q1');

    const voice = normalizeWaMessage(msg({ message: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } } }), { now: NOW });
    expect(voice?.attachment?.kind).toBe('voice');

    const doc = normalizeWaMessage(msg({ message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'смета.pdf', mimetype: 'application/pdf', caption: 'КП' } } } } }), { now: NOW });
    expect(doc?.attachment).toMatchObject({ kind: 'file', name: 'смета.pdf' });
    expect(doc?.text).toBe('КП');
  });

  it('группа: автор из participant, название из метаданных', () => {
    const ev = normalizeWaMessage(
      msg({ key: { remoteJid: '120363000000@g.us', id: 'G1', fromMe: false, participant: '79995556677@s.whatsapp.net' }, pushName: 'Пётр' }),
      { now: NOW, groupTitle: () => 'Рабочие моменты' },
    );
    expect(ev).toMatchObject({ isGroup: true, chatTitle: 'Рабочие моменты', author: { id: '79995556677@s.whatsapp.net', name: 'Пётр' }, contact: {} });
  });

  it('сообщение с телефона менеджера — fromMe', () => {
    const ev = normalizeWaMessage(msg({ key: { remoteJid: '79991234567@s.whatsapp.net', id: 'M1', fromMe: true } }), { now: NOW });
    expect(ev?.fromMe).toBe(true);
  });

  it('служебное и старое не передаётся', () => {
    expect(normalizeWaMessage(msg({ key: { remoteJid: 'status@broadcast', id: 'S', fromMe: false } }), { now: NOW })).toBeNull();
    expect(normalizeWaMessage(msg({ message: { protocolMessage: {} } }), { now: NOW })).toBeNull();
    expect(normalizeWaMessage(msg({ message: { reactionMessage: { text: '👍' } } }), { now: NOW })).toBeNull();
    expect(normalizeWaMessage(msg({ messageTimestamp: NOW - 3 * 86400 }), { now: NOW })).toBeNull();
    expect(normalizeWaMessage(msg({ message: {} }), { now: NOW })).toBeNull();
  });
});

describe('WhatsApp: сессия в БД', () => {
  it('ключи и данные входа сохраняются одной записью и читаются обратно', async () => {
    let saved: string | null = null;
    const storage = { load: async () => saved, save: async (j: string) => void (saved = j) };
    const a = await createDbAuthState(storage, { flushDelayMs: 5 });
    expect(a.registered).toBe(false);
    await a.state.keys.set({ 'pre-key': { '1': { public: Buffer.from([1, 2]), private: Buffer.from([3]) } } });
    a.state.creds.me = { id: '79991234567:5@s.whatsapp.net' };
    await a.saveCreds();
    await a.flush();
    expect(saved).not.toBeNull();

    const b = await createDbAuthState(storage);
    expect(b.registered).toBe(true);
    const keys = await b.state.keys.get('pre-key', ['1', '2']);
    expect(Buffer.isBuffer(keys['1']?.public)).toBe(true);
    expect(keys['2']).toBeUndefined();
    await b.state.keys.set({ 'pre-key': { '1': null } });
    expect(await b.state.keys.get('pre-key', ['1'])).toEqual({});
  });

  it('новая сессия начинается с чистых данных входа', async () => {
    const a = await createDbAuthState({ load: async () => null, save: async () => undefined });
    expect(a.state.creds.registrationId).toBeTypeOf('number');
    expect(Object.keys(a.state.creds).sort()).toEqual(Object.keys(initAuthCreds()).sort());
  });
});

describe('WhatsApp: подключение из виджета', () => {
  it('канал создаётся без ключей, номер появится после QR', async () => {
    const a = await validateChannel({ kind: 'whatsapp' });
    const b = await validateChannel({ kind: 'whatsapp' });
    expect(a.kind).toBe('whatsapp');
    expect(a.credentials).toEqual({});
    expect(a.externalId).toMatch(/^pending-/);
    expect(a.externalId).not.toBe(b.externalId);
  });
});
