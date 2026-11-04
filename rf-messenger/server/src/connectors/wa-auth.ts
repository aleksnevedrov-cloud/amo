import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from 'baileys';

/** Снимок сессии WhatsApp целиком: ключи шифрования и данные входа. */
interface SessionSnapshot {
  creds: AuthenticationCreds;
  keys: Record<string, Record<string, unknown>>;
}

export interface SessionStorage {
  /** Расшифрованный JSON сессии или null, если входа ещё не было. */
  load(): Promise<string | null>;
  save(json: string): Promise<void>;
}

/**
 * Сессия Baileys в БД вместо папки с файлами: весь снимок хранится одной зашифрованной строкой
 * в channels.session. Запись — с задержкой, чтобы пачка обновлений ключей стала одной записью.
 */
export async function createDbAuthState(storage: SessionStorage, opts: { flushDelayMs?: number } = {}) {
  const raw = await storage.load();
  const snap: SessionSnapshot = raw ? (JSON.parse(raw, BufferJSON.reviver) as SessionSnapshot) : { creds: initAuthCreds(), keys: {} };
  const delay = opts.flushDelayMs ?? 1500;
  let timer: NodeJS.Timeout | null = null;
  let writing: Promise<void> = Promise.resolve();

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const json = JSON.stringify(snap, BufferJSON.replacer);
    writing = writing.then(() => storage.save(json));
    await writing;
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(() => void flush().catch(() => undefined), delay);
  };

  const state: AuthenticationState = {
    creds: snap.creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const bucket = snap.keys[type] ?? {};
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          let value = bucket[id];
          if (value !== undefined && value !== null) {
            if (type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
            out[id] = value as SignalDataTypeMap[T];
          }
        }
        return out;
      },
      set: async (data) => {
        for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          const bucket = new Map(Object.entries(snap.keys[type] ?? {}));
          for (const [id, value] of Object.entries(data[type] ?? {})) {
            if (value === null || value === undefined) bucket.delete(id);
            else bucket.set(id, value);
          }
          snap.keys[type] = Object.fromEntries(bucket);
        }
        schedule();
      },
    },
  };

  return {
    state,
    /** Вызывать на creds.update. */
    saveCreds: async () => schedule(),
    /** Немедленная запись (при остановке коннектора). */
    flush,
    /** Вход выполнен: в сессии есть учётная запись. */
    get registered() {
      return Boolean(snap.creds.me?.id);
    },
  };
}
