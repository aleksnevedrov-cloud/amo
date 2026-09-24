export interface Alerter {
  alert(message: string): Promise<void>;
}

/** Алерты заказчику в Telegram (раздел 13 ТЗ). Без токена — no-op. */
export class TelegramAlerter implements Alerter {
  constructor(
    private readonly botToken: string | undefined,
    private readonly chatId: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async alert(message: string): Promise<void> {
    if (!this.botToken || !this.chatId) return;
    await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text: `[AI-агент] ${message}` }),
      signal: AbortSignal.timeout(10_000),
    });
  }
}
