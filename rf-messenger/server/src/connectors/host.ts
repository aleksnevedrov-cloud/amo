import type { Bridge, Logger } from '../bridge.ts';
import type { SecretBox } from '../crypto.ts';
import type { Channel, Store } from '../store.ts';
import { TelegramBotConnector } from './telegram-bot.ts';
import type { Connector } from './types.ts';

export type ConnectorFactory = (channel: Channel, credentials: Record<string, string>) => Connector | null;

export const defaultFactory: ConnectorFactory = (channel, creds) => {
  if (channel.kind === 'telegram_bot' && creds.token) return new TelegramBotConnector(creds.token);
  return null; // WhatsApp, Telegram личный, MAX, VK, Авито — следующие этапы
};

/**
 * Держит коннекторы всех активных каналов в процессе коннекторов.
 * Сбой одного коннектора не останавливает остальные: ошибки ловятся и пишутся в статус канала.
 */
export class ConnectorHost {
  private readonly running = new Map<number, Connector>();

  constructor(
    private readonly store: Store,
    private readonly box: SecretBox,
    private readonly bridge: () => Bridge,
    private readonly log: Logger,
    private readonly factory: ConnectorFactory = defaultFactory,
  ) {}

  get(channelId: number): Connector | undefined {
    return this.running.get(channelId);
  }

  /** Сверка с БД: запустить новые каналы, остановить удалённые. */
  async syncAll(): Promise<void> {
    const channels = await this.store.activeChannels();
    const ids = new Set(channels.map((c) => c.id));
    for (const id of [...this.running.keys()]) if (!ids.has(id)) await this.stopOne(id, true);
    for (const c of channels) if (!this.running.has(c.id)) await this.startOne(c);
  }

  private async startOne(channel: Channel): Promise<void> {
    let connector: Connector | null;
    try {
      connector = this.factory(channel, JSON.parse(this.box.decrypt(channel.credentials)) as Record<string, string>);
    } catch {
      await this.store.setChannelStatus(channel.id, 'error', 'Не удалось прочитать ключи канала — подключите заново');
      return;
    }
    if (!connector) {
      await this.store.setChannelStatus(channel.id, 'error', 'Этот тип канала будет доступен на следующем этапе');
      return;
    }
    this.running.set(channel.id, connector);
    const c = connector;
    await c
      .start({
        inbound: (ev) => this.bridge().onInbound(channel, c, ev),
        status: (status, detail) => this.store.setChannelStatus(channel.id, status, detail ?? null),
      })
      .catch(async (err: Error) => {
        this.running.delete(channel.id);
        this.log.error({ channelId: channel.id, err: err.message }, 'коннектор не запущен');
        await this.store.setChannelStatus(channel.id, 'error', 'Коннектор не запустился');
      });
    this.log.info({ channelId: channel.id, kind: channel.kind }, 'коннектор запущен');
  }

  /** Перезапуск канала (кнопка «Новый QR» в виджете). */
  async restart(id: number): Promise<void> {
    await this.stopOne(id);
    const channel = await this.store.channelById(id);
    if (channel) await this.startOne(channel);
  }

  private async stopOne(id: number, removed = false): Promise<void> {
    const c = this.running.get(id);
    this.running.delete(id);
    await (removed && c?.logout ? c.logout() : c?.stop())?.catch(() => undefined);
    this.log.info({ channelId: id }, 'коннектор остановлен');
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.running.keys()]) await this.stopOne(id);
  }
}
