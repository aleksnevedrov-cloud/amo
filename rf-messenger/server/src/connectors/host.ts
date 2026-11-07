import type { Bridge, Logger } from '../bridge.ts';
import type { SecretBox } from '../crypto.ts';
import type { Channel, Store } from '../store.ts';
import { AvitoConnector } from './avito.ts';
import { MaxConnector } from './max.ts';
import { TelegramBotConnector } from './telegram-bot.ts';
import type { Connector } from './types.ts';
import { VkConnector } from './vk.ts';

export type ConnectorFactory = (channel: Channel, credentials: Record<string, string>) => Connector | null;

/** Адрес вебхука Авито: секрет — в адресе, по нему api узнаёт запрос Авито. */
export const avitoWebhookUrl = (publicUrl: string, channelId: number, secret: string) => new URL(`/hooks/avito/${channelId}/${secret}`, publicUrl).toString();

export interface FactoryOptions {
  /** Публичный адрес сервиса для вебхука Авито. Пусто — Авито работает только опросом. */
  publicUrl?: string;
  log?: (channelId: number, level: 'warn' | 'error', msg: string) => void;
}

/** Коннекторы без внешних зависимостей процесса (MAX, VK, Авито, Telegram-бот без прокси). WhatsApp и Telegram личный — в main-connectors. */
export function makeFactory(o: FactoryOptions = {}): ConnectorFactory {
  return (channel, creds) => {
    const log = (level: 'warn' | 'error', msg: string) => o.log?.(channel.id, level, msg);
    const onError = (err: unknown) => log('warn', `${channel.kind}: ${(err as Error).message}`);
    if (channel.kind === 'telegram_bot' && creds.token) return new TelegramBotConnector(creds.token);
    if (channel.kind === 'max' && creds.token) return new MaxConnector(creds.token, { onError });
    if (channel.kind === 'vk' && creds.token && creds.groupId) return new VkConnector(creds.token, Number(creds.groupId), { onError });
    if (channel.kind === 'avito' && creds.clientId && creds.clientSecret && creds.userId) {
      return new AvitoConnector(
        { clientId: creds.clientId, clientSecret: creds.clientSecret, userId: Number(creds.userId) },
        { ...(o.publicUrl && creds.webhookSecret ? { webhookUrl: avitoWebhookUrl(o.publicUrl, channel.id, creds.webhookSecret) } : {}), onError, log },
      );
    }
    return null; // WhatsApp и Telegram личный создаются в main-connectors (нужны сессия, QR, прокси)
  };
}

export const defaultFactory: ConnectorFactory = makeFactory();

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

  /** Перезапуск всех каналов одного типа (WhatsApp после смены прокси). Сессии не сбрасываются. */
  async restartKind(kind: Channel['kind']): Promise<void> {
    const channels = await this.store.activeChannels();
    for (const c of channels) if (c.kind === kind && this.running.has(c.id)) await this.restart(c.id);
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
