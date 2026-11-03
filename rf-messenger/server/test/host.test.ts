import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectorHost } from '../src/connectors/host.ts';
import { FakeConnector, setupBridge, silent } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupBridge>>;
beforeEach(async () => {
  t = await setupBridge();
});
afterEach(async () => {
  await t.drop();
});

describe('процесс коннекторов', () => {
  it('запускает активные каналы, останавливает удалённые; неизвестный тип и битые ключи — статус «Ошибка»', async () => {
    const started: number[] = [];
    const fake = new FakeConnector();
    const host = new ConnectorHost(t.store, t.box, () => t.bridge, silent, (ch) => {
      if (ch.kind !== 'telegram_bot') return null;
      started.push(ch.id);
      return fake;
    });
    const wa = (await t.store.createChannel({ accountId: 31337, kind: 'whatsapp', title: 'WA', externalId: '79990000000', credentials: t.box.encrypt('{}') }))!;
    const broken = (await t.store.createChannel({ accountId: 31337, kind: 'telegram_bot', title: 'b', externalId: '9', credentials: 'garbage' }))!;

    await host.syncAll();
    expect(started).toEqual([t.channel.id]);
    expect(host.get(t.channel.id)).toBe(fake);
    expect((await t.store.channelById(wa.id))?.statusDetail).toMatch(/следующем этапе/);
    expect((await t.store.channelById(broken.id))?.status).toBe('error');

    await t.store.deleteChannel(31337, t.channel.id);
    await host.syncAll();
    expect(host.get(t.channel.id)).toBeUndefined();
    // Удалённый канал: ключи стёрты.
    const row = await t.db.query('SELECT credentials FROM channels WHERE id = $1', [t.channel.id]);
    expect(row.rows[0].credentials).toBe('');
  });
});
