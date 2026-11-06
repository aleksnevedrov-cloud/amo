import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bridge } from '../src/bridge.ts';
import { event, setupBridge } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupBridge>>;
beforeEach(async () => {
  t = await setupBridge();
});
afterEach(async () => {
  await t.drop();
});

const photo = { kind: 'picture' as const, ref: 'wa-photo-1', name: 'photo.jpg', mime: 'image/jpeg' };

describe('входящее фото не теряется', () => {
  it('зависшее скачивание вложения обрывается по таймауту, сообщение всё равно уходит в amo', async () => {
    t.connector.download = () => new Promise(() => undefined); // прокси повис и не отвечает
    const bridge = new Bridge({ ...t.bridgeDeps, mediaTimeoutMs: 50 });
    await bridge.onInbound(t.channel, t.connector, event({ text: '', attachment: photo }));
    expect(t.queue.jobs.map((j) => j.name)).toEqual(['to-amo']);
    await bridge.deliverToAmo(t.queue.jobs[0]!.data.messageId);
    const p = t.calls.at(-1)!.body.payload as { message: { type: string; text: string } };
    expect(p.message).toEqual({ type: 'text', text: '[Вложение не получено]' });
  });

  it('сообщение, оставшееся без задачи to-amo (сбой процесса), подбирается повторно', async () => {
    const chat = await t.store.upsertChat(t.channel, { externalChatId: '42', isGroup: false, title: 'Иван', contact: {} });
    const msg = (await t.store.insertFromChannel({ chat, source: 'client', kind: 'picture', text: '', author: null, externalId: 'X1', replyToExternalId: null }))!;
    await t.db.query("UPDATE messages SET created_at = now() - interval '10 minutes' WHERE id = $1", [msg.id]);
    // Свежее сообщение не трогаем: его ещё обрабатывает onInbound.
    const fresh = (await t.store.insertFromChannel({ chat, source: 'client', kind: 'text', text: 'x', author: null, externalId: 'X2', replyToExternalId: null }))!;

    expect(await t.bridge.requeueStuckInbound()).toBe(1);
    expect(t.queue.jobs).toEqual([{ name: 'to-amo', data: { messageId: msg.id }, jobId: `to-amo-${msg.id}` }]);
    expect(t.queue.jobs.some((j) => j.data.messageId === fresh.id)).toBe(false);

    await t.bridge.deliverToAmo(msg.id);
    expect(await t.bridge.requeueStuckInbound()).toBe(0); // после передачи в amo — уже не «завис»
  });
});

