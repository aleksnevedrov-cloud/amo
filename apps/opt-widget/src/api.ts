import type { KpConstants as CoreKpConstants, KpDraftStatus } from '@core/db';
import type { ModelInfo, ModelRef, ProviderId } from '@core/llm/types';
import { ApiClient } from '@core/widget-core';
// Только схема настроек: остальной @opt/kp — серверный код, виджету он не нужен.
import type { OptSettings } from '@opt/kp/settings';

export type { ModelInfo, ModelRef, OptSettings, ProviderId };

/** Константы КП опта: к общему набору добавлена фраза о ценах (плейсхолдер {{price_note}}). */
export type KpConstants = CoreKpConstants & { priceNote?: string; analogPriceTolerancePct?: number; manufacturerDomains?: string[] };

export interface Status {
  accountId: number;
  isAdmin: boolean;
  connected: boolean;
  tokenExpiresAt: string | null;
  tokenError: string | null;
  llmConfigured: boolean;
  llm: { provider: ProviderId; model: string; fallback: ModelRef | null; providers: ProviderId[] };
  mailConfigured: boolean;
  templateLoaded: boolean;
  spend: { todayRub: number; monthRub: number };
}

/** Строка будущего КП: её правит менеджер перед сборкой. */
export interface KpDraftLine {
  request_index: number;
  page_id: string | null;
  name: string;
  size: string;
  qty: number;
  price: number | null;
  lead_time: string;
  discount: number;
}

export interface KpDraftInfo {
  id: number;
  leadId: number;
  status: KpDraftStatus;
  kpNo: string | null;
  createdAt: string;
  builtAt: string | null;
  sentAt: string | null;
  hasDocx: boolean;
  hasPdf: boolean;
  client: { org: string; fio: string; email: string; phone: string };
  requestItems: { raw: string; name: string; width_mm: number | null; height_mm: number | null; qty: number }[];
  items: KpDraftLine[];
  requiredBlocks: string[];
  questions: string[];
  needsManager: { request_index: number; reason: string }[];
  source: { from: string; mails: number; letterAt: string | null; attachments: string[]; documents: number[]; skipped: { name: string; reason: string }[] } | null;
}

/** Состояние задания воркера «собрать черновик». */
export type DraftJob = { state: 'queued' | 'running' } | { state: 'failed'; error: string } | null;

export interface KpSettingsInfo {
  constants: KpConstants;
  certsDir: string | null;
  numbering: { prefix: string; year: number | null; counter: number };
  template: { exists: boolean; name: string | null; md5: string | null; updatedAt: string | null };
}

export interface SendPreviewInfo {
  to: string;
  cc: string;
  subject: string;
  text: string;
  signature: string;
  attachment: { name: string; bytes: number | null } | null;
  blockers: string[];
  warnings: string[];
  alreadySent: boolean;
}

export interface JournalItem {
  id: number;
  leadId: number | null;
  kind: string;
  summary: string;
  details: Record<string, unknown>;
  costRub: number;
  createdAt: string;
}

export interface LlmKeys {
  provider: ProviderId;
  fallbackProvider: ProviderId;
  keys: Record<string, { saved: boolean; mask: string | null; source: 'account' | 'server' | null }>;
  providers: ProviderId[];
}

export interface ModelsInfo {
  provider: ProviderId;
  models: ModelInfo[];
  fetchedAt: string | null;
  fromCache: boolean;
  source: 'api' | 'tariff';
  noKey: boolean;
  error?: string;
}

/** Клиент бэкенда «Агента опт» (opt.rf-dveri.ru): маршруты /widget/v1/*. */
export class KpApi extends ApiClient {
  status = () => this.call<Status>('GET', '/widget/v1/status');
  settings = () => this.call<{ settings: OptSettings; version: number }>('GET', '/widget/v1/settings');
  saveSettings = (settings: OptSettings) => this.call<{ settings: OptSettings; version: number }>('PUT', '/widget/v1/settings', settings);
  saveSmtpPassword = (password: string) => this.call<{ ok: true }>('PUT', '/widget/v1/settings/smtp-password', { password });
  journal = (q: { leadId?: number; kind?: string; before?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
    return this.call<{ items: JournalItem[] }>('GET', `/widget/v1/journal${qs.size ? `?${qs}` : ''}`);
  };

  llmKeys = () => this.call<LlmKeys>('GET', '/widget/v1/llm/keys');
  saveLlmKey = (provider: ProviderId, key: string) => this.call<{ ok: true }>('PUT', '/widget/v1/llm/key', { provider, key });
  removeLlmKey = (provider: ProviderId) => this.call<{ ok: true }>('DELETE', `/widget/v1/llm/key?provider=${provider}`);
  testLlmKey = (provider: ProviderId, key?: string) =>
    this.call<{ ok: true; models: string[] } | { ok: false; error: string }>('POST', '/widget/v1/llm/test', { provider, ...(key ? { key } : {}) });
  models = (provider: ProviderId, refresh = false) => this.call<ModelsInfo>('GET', `/widget/v1/llm/models?provider=${provider}${refresh ? '&refresh=1' : ''}`);

  /** Черновик по сделке и состояние задания воркера. */
  draft = (leadId: number) => this.call<{ draft: KpDraftInfo | null; job: DraftJob }>('GET', `/widget/v1/kp/draft?leadId=${leadId}`);
  /** Кнопка «Собрать КП»: задание в очередь, ответ сразу. */
  makeDraft = (leadId: number) => this.call<{ queued: true }>('POST', '/widget/v1/kp/draft', { leadId });
  saveDraftItems = (id: number, items: KpDraftLine[]) => this.call<{ draft: KpDraftInfo | null }>('PUT', `/widget/v1/kp/draft/${id}`, { items });
  /** Кнопка «Собрать документ»: DOCX по шаблону и PDF, файлы уходят в карточку сделки. */
  buildDoc = (draftId: number) => this.call<{ draft: KpDraftInfo | null; pdf: boolean; attached: string[] }>('POST', '/widget/v1/kp/build', { draftId });
  sendPreview = (draftId: number) => this.call<SendPreviewInfo>('GET', `/widget/v1/kp/send/preview?draftId=${draftId}`);
  /** «Проверено, отправить»: письмо уходит только отсюда. */
  send = (body: { draftId: number; to: string; cc?: string; subject: string; text: string; resendConfirmed?: boolean }) =>
    this.call<{ draft: KpDraftInfo | null; to: string }>('POST', '/widget/v1/kp/send', body);


  kpSettings = () => this.call<KpSettingsInfo>('GET', '/widget/v1/kp/settings');
  saveKpSettings = (patch: { constants?: KpConstants; certsDir?: string | null; numbering?: { prefix?: string; counter?: number } }) =>
    this.call<{ ok: true }>('PUT', '/widget/v1/kp/settings', patch);
  uploadTemplate = (filename: string, contentBase64: string) =>
    this.call<{ ok: true; md5: string; size: number }>('POST', '/widget/v1/kp/template', { filename, contentBase64 });
}
