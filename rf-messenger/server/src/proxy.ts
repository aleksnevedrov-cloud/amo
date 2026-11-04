import type { Agent } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent, type Dispatcher } from 'undici';

/**
 * Исходящий прокси для Telegram и WhatsApp (MESSENGER_PROXY_URL).
 * Глобальный диспетчер не меняется: amoCRM, postgres, redis и localhost идут напрямую.
 */
export interface MessengerProxy {
  /** Для fetch (undici 6, как встроенный fetch Node 22): Bot API Telegram, скачивание медиа WhatsApp. */
  dispatcher: Dispatcher;
  /** Для node:https/ws: веб-сокет WhatsApp и загрузка медиа (Baileys в Node шлёт её через https.request). */
  agent: Agent;
  /** Адрес прокси без логина и пароля — для журналов. */
  display: string;
}

/** Адрес прокси для журналов: логин и пароль заменены на ***. */
export function maskProxyUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '***';
    }
    return u.toString();
  } catch {
    return '[некорректный адрес прокси]';
  }
}

/** Пустой адрес — null: всё напрямую. */
export function createMessengerProxy(raw: string | undefined): MessengerProxy | null {
  const url = raw?.trim();
  if (!url) return null;
  return {
    dispatcher: new ProxyAgent(url),
    agent: new HttpsProxyAgent(url) as unknown as Agent,
    display: maskProxyUrl(url),
  };
}

/** Строки, которых не должно быть в журналах: адрес прокси целиком, логин и пароль (как есть и в URL-кодировке). */
export function proxySecrets(raw: string | undefined): string[] {
  const url = raw?.trim();
  if (!url) return [];
  const out = new Set<string>([url]);
  try {
    const u = new URL(url);
    for (const part of [u.username, u.password]) {
      if (!part) continue;
      out.add(part);
      try {
        out.add(decodeURIComponent(part));
      } catch {
        // некорректная %-последовательность — достаточно исходного вида
      }
    }
  } catch {
    // адрес не разбирается — маскируем только целиком
  }
  // В JSON-журнале кавычки и обратные косые черты экранированы.
  for (const s of [...out]) out.add(JSON.stringify(s).slice(1, -1));
  return [...out].filter((s) => s.length >= 3).sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('***');
  return out;
}
