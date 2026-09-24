import type { AmoWidgetSelf } from './amo.ts';

export type Mode = 'auto' | 'semi' | 'hints' | 'off';

export interface WidgetSettings {
  enabled: boolean;
  mode: Mode;
}

export interface Status {
  accountId: number;
  connected: boolean;
  tokenExpiresAt: string | null;
  tokenError: string | null;
  enabled: boolean;
  mode: Mode;
}

export interface LeadPanel {
  leadId: number;
  ai: { mode: Mode; paused: boolean };
  hints: unknown[];
  products: unknown[];
  calculations: unknown[];
  log: unknown[];
}

export class WidgetApi {
  constructor(
    private readonly self: AmoWidgetSelf,
    private readonly baseUrl: string,
  ) {}

  status() {
    return this.call<Status>('GET', '/widget/v1/status');
  }

  settings() {
    return this.call<{ settings: WidgetSettings; version: number }>('GET', '/widget/v1/settings');
  }

  saveSettings(settings: WidgetSettings) {
    return this.call<{ settings: WidgetSettings; version: number }>('PUT', '/widget/v1/settings', settings);
  }

  leadPanel(leadId: number) {
    return this.call<LeadPanel>('GET', `/widget/v1/leads/${leadId}/panel`);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.self.$authorizedAjax({
      url: new URL(path, this.baseUrl).toString(),
      method,
      type: method,
      dataType: 'json',
      ...(body === undefined ? {} : { data: JSON.stringify(body), contentType: 'application/json' }),
    });
    return res as T;
  }
}
