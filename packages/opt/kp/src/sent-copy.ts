import { ImapFlow } from 'imapflow';
import type { OptSettings } from './settings.ts';

/**
 * KP-SENT-COPY: копия отправленного КП в «Отправленные» ящика. SMTP Яндекса сам письмо в «Отправленные» не кладёт —
 * после успешной отправки тот же MIME добавляется туда по IMAP (APPEND с флагом \Seen). Папка — по признаку \Sent
 * (SPECIAL-USE), запасной вариант — «Sent» / «Отправленные»; можно задать в настройках. Ошибка копии отправку не отменяет.
 */

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export interface SentFolderProbe {
  /** Найденная (или заданная в настройках) папка отправленных; null — не нашлась. */
  folder: string | null;
  /** Как найдена: по признаку \Sent, по имени или задана в настройках. */
  how: 'special_use' | 'name' | 'settings' | null;
  folders: string[];
}

export interface SentCopier {
  /** Кладёт письмо в папку отправленных; возвращает папку. Бросает ошибку с причиной. */
  append(cfg: ImapConfig, raw: Buffer, folder: string | null): Promise<{ folder: string }>;
  /** «Проверить IMAP»: вход и поиск папки отправленных. */
  probe(cfg: ImapConfig, folder: string | null): Promise<SentFolderProbe>;
}

/** Подключение не дольше 15 с, вся операция — не дольше 60 с (письмо с PDF до 25 МБ). */
const CONNECT_MS = 15_000;
const TOTAL_MS = 60_000;

/** Имена папки отправленных без признака \Sent (последний уровень пути). */
const SENT_NAME = /^(sent|sent items|sent messages|sent mail|отправленные|отправленные письма)$/i;

/**
 * IMAP того же ящика, что и SMTP: smtp.yandex.ru → imap.yandex.ru (порт и TLS — из настроек, по умолчанию 993 и TLS).
 * SMTP без префикса «smtp.» — IMAP-сервер из настроек (тот же, что для чтения письма заявки).
 */
export function imapConfigFor(mail: OptSettings['mail'], password: string): ImapConfig {
  const smtp = mail.smtpHost.trim();
  const host = /^smtp\./i.test(smtp) ? smtp.replace(/^smtp\./i, 'imap.') : mail.imapHost.trim() || smtp;
  return { host, port: mail.imapPort || 993, secure: mail.imapSecure, username: mail.username, password };
}

/** Папка отправленных по списку папок: заданная в настройках → признак \Sent → имя «Sent» / «Отправленные». */
export function pickSentFolder(list: { path: string; name?: string; specialUse?: string; flags?: Set<string> | string[] }[], configured: string | null): SentFolderProbe {
  const folders = list.map((f) => f.path);
  const wanted = configured?.trim();
  if (wanted) {
    const hit = list.find((f) => f.path.toLowerCase() === wanted.toLowerCase());
    return { folder: hit?.path ?? wanted, how: 'settings', folders };
  }
  const flags = (f: (typeof list)[number]) => [...(f.flags ?? [])].map((x) => String(x));
  const special = list.find((f) => f.specialUse === '\\Sent' || flags(f).includes('\\Sent'));
  if (special) return { folder: special.path, how: 'special_use', folders };
  const byName = list.find((f) => SENT_NAME.test((f.name ?? f.path.split(/[/.|]/).pop() ?? '').trim()));
  return byName ? { folder: byName.path, how: 'name', folders } : { folder: null, how: null, folders };
}

export class ImapSentCopier implements SentCopier {
  async append(cfg: ImapConfig, raw: Buffer, folder: string | null): Promise<{ folder: string }> {
    return this.session(cfg, async (c) => {
      const found = pickSentFolder(await c.list(), folder);
      if (!found.folder) throw new Error(`в ящике ${cfg.username} не найдена папка отправленных (папки: ${found.folders.join(', ') || 'нет'}) — укажите её в настройках «Папка отправленных»`);
      const r = await c.append(found.folder, raw, ['\\Seen']);
      if (!r) throw new Error(`сервер ${cfg.host} не принял письмо в папку «${found.folder}»`);
      return { folder: found.folder };
    });
  }

  async probe(cfg: ImapConfig, folder: string | null): Promise<SentFolderProbe> {
    return this.session(cfg, async (c) => pickSentFolder(await c.list(), folder));
  }

  /** Подключение, действие, выход; по истечении общего времени соединение закрывается с понятной ошибкой. */
  private async session<T>(cfg: ImapConfig, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const c = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.username, pass: cfg.password },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: CONNECT_MS,
      greetingTimeout: CONNECT_MS,
      socketTimeout: TOTAL_MS,
    });
    // Без обработчика 'error' событие imapflow роняет процесс (как у чтения письма заявки).
    c.on('error', () => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        c.close();
        reject(new Error(`IMAP ${cfg.host}: нет ответа за ${TOTAL_MS / 1000} с`));
      }, TOTAL_MS);
    });
    try {
      return await Promise.race([
        (async () => {
          try {
            await c.connect();
          } catch (err) {
            throw new Error(imapLoginError(cfg, err));
          }
          return fn(c);
        })(),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
      await c.logout().catch(() => c.close());
    }
  }
}

/** Причина входа словами: неверный пароль / IMAP выключен в ящике — частое у Яндекса. */
function imapLoginError(cfg: ImapConfig, err: unknown): string {
  const e = err as { message?: string; authenticationFailed?: boolean; responseText?: string; code?: string } | null;
  const text = [e?.responseText, e?.message].filter(Boolean).join(' — ');
  if (e?.authenticationFailed || /AUTHENTICATIONFAILED|authentication failed|invalid credentials|LOGIN failed/i.test(text)) {
    return `IMAP ${cfg.host}: вход ${cfg.username} не удался (${text || 'неверный логин или пароль'}) — проверьте пароль приложения и что в настройках ящика включён доступ по IMAP`;
  }
  return `IMAP ${cfg.host}:${cfg.port}: ${text || e?.code || 'нет соединения'}`;
}
