import { jwtVerify } from 'jose';
import { AmoError } from './errors.ts';

/**
 * Salesbot, шаг виджета (`widget_request`): amo делает POST на наш URL с телом
 * { token, data, return_url }. token — JWT HS512, подписанный client_secret
 * (сверено с amocrm/amocrm-api-php, parseBotDisposableToken). Чтобы бот продолжил
 * работу, нужно сделать POST на return_url с access-токеном аккаунта.
 * Формат тела ответа (data / execute_handlers / show) — по документации Kommo
 * «Private chatbot integration»; сверить на живом аккаунте.
 */
export interface SalesbotRequest {
  token: string;
  data: Record<string, unknown>;
  return_url: string;
}

export interface BotPrincipal {
  accountId: number;
  subdomain: string | null;
}

export async function verifyBotToken(
  token: string,
  opts: { clientSecret: string; now?: Date },
): Promise<BotPrincipal & Record<string, unknown>> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(opts.clientSecret), {
    algorithms: ['HS512'],
    clockTolerance: 30,
    ...(opts.now ? { currentDate: opts.now } : {}),
  });
  const accountId = Number(payload.account_id);
  if (!Number.isInteger(accountId) || accountId <= 0) throw new Error('В токене бота нет account_id');
  return { ...payload, accountId, subdomain: typeof payload.subdomain === 'string' ? payload.subdomain : null };
}

/** return_url должен вести на домен аккаунта amo: туда уходит access-токен. */
export function isSafeReturnUrl(returnUrl: string, accountDomain: string): boolean {
  try {
    const u = new URL(returnUrl);
    return u.protocol === 'https:' && u.host === accountDomain;
  } catch {
    return false;
  }
}

export async function continueBot(
  returnUrl: string,
  accessToken: string,
  messages: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(returnUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    // Хендлер show ограничен 80 символами (amoCRM отвечает 400 TooLong), поэтому текст отдаём через data:
    // в боте следующим шагом «Отправить сообщение» с текстом {{json.reply}}.
    body: JSON.stringify({
      data: {
        status: 'success',
        reply: messages.join('\n\n'),
        has_reply: messages.length ? '1' : '0',
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AmoError(`Salesbot continue: HTTP ${res.status} ${body.slice(0, 300)}`, res.status, body);
  }
}
