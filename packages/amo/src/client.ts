import { AmoError } from './errors.ts';

export interface AmoAccount {
  id: number;
  name: string;
  subdomain: string;
}

/** Минимальный клиент amoCRM API v4. Расширяется в следующих фазах. */
export class AmoApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly accountDomain: string,
    private readonly getAccessToken: () => Promise<string>,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  getAccount(): Promise<AmoAccount> {
    return this.get<AmoAccount>('/api/v4/account');
  }

  private async get<T>(path: string): Promise<T> {
    const token = await this.getAccessToken();
    const res = await this.fetchImpl(`https://${this.accountDomain}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new AmoError(`amo API GET ${path}: HTTP ${res.status}`, res.status, await res.text().catch(() => ''));
    }
    return (await res.json()) as T;
  }
}
