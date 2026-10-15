import type { KpConstants as CoreKpConstants, KpDraftStatus } from '@core/db';
import type { ModelInfo, ModelRef, ProviderId } from '@core/llm/types';
import { ApiClient } from '@core/widget-core';
// Только схема настроек: остальной @opt/kp — серверный код, виджету он не нужен.
import type { OptSettings } from '@opt/kp/settings';

export type { ModelInfo, ModelRef, OptSettings, ProviderId };

/** Константы КП опта: к общему набору добавлена фраза о ценах (плейсхолдер {{price_note}}). */
export type KpConstants = CoreKpConstants & {
  priceNote?: string;
  analogPriceTolerancePct?: number;
  manufacturerDomains?: string[];
  // Поиск рыночных цен (RFD-AI-AGENT-OPT-PRICE): коэффициенты, автозапуск, кэш, лимит.
  priceCoefficient?: number;
  manufacturerCoefficients?: Record<string, number>;
  autoResearch?: boolean;
  researchCacheDays?: number;
  maxPositionsPerRun?: number;
  // База знаний (RFD-AI-AGENT-OPT-KB): лимит вызовов поиска на позицию, дневной лимит $, выключатель приоритета базы.
  maxSearchCalls?: number;
  webSearchDailyUsd?: number;
  skipKnowledgeBase?: boolean;
};

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
  /** Откуда цена: поиск по точной модели, аналог, менеджер руками или база знаний (kb). */
  priceSource?: 'research' | 'analog' | 'manager' | 'kb';
  market?: { median: number; min: number; max: number; count: number; unit: 'piece'; researchId: number; researchedAt: string } | null;
  coefficient?: number;
  /** Подпись источника цены в плитке: «по базе: прайс Текона (01.10.2026)», «по закупке», «по рынку», «изменено менеджером». */
  priceLabel?: string | null;
  /** Срок актуальности вышел — «цена устарела». */
  priceStale?: boolean;
  kbPriceId?: number | null;
  /** service — работы и услуги: после товаров под заголовком, без размера и без поиска цены (XLSX-2). */
  kind?: 'product' | 'service';
}

/** Состояние поиска цен по позициям черновика (GET /kp/research). */
export interface ResearchOffer {
  url: string;
  seller: string;
  title: string;
  price: number;
  currency: string;
  unit: 'piece' | 'set' | 'm2';
  vatStated: 'included' | 'no_vat' | 'pre_net' | 'unknown';
  unitPrice: number | null;
  accepted: boolean;
  reason: string | null;
  manufacturer: boolean;
  formula: string | null;
  notes: string[];
  vatAssumed: boolean;
  areaScaled: boolean;
  sourceSize: string | null;
  foundAt: string;
}

export interface ResearchPosition {
  requestIndex: number;
  job: DraftJob;
  research: {
    id: number;
    status: 'ok' | 'none' | 'failed';
    query: string;
    stats: { min: number; max: number; median: number; count: number; unit: 'piece' } | null;
    error: string | null;
    createdAt: string;
    webSearchCalls: number;
    costUsd: number;
    analog: { url: string; unitPrice: number | null; reason: string } | null;
    offers: ResearchOffer[];
  } | null;
}

export interface ResearchState {
  draftId: number;
  pending: boolean;
  positions: ResearchPosition[];
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
  source: {
    from: string;
    mails: number;
    letterAt: string | null;
    attachments: string[];
    documents: number[];
    skipped: { name: string; reason: string }[];
    /** Чтение письма из ящика (вариант А); нет — ящик не настроен. */
    mail?: MailSourceInfo;
  } | null;
}

/** Чтение письма из ящика — как сохранено в payload черновика (те же данные, что в событии mail_fetch журнала). */
export interface MailSourceInfo {
  status: 'found' | 'not_found' | 'error' | 'partial';
  searchedFrom: string;
  from?: string | null;
  fromName?: string | null;
  subject?: string;
  date: string | null;
  folder?: string | null;
  matchedBy?: 'address' | 'domain' | null;
  attachments: number;
  taken: string[];
  uploaded: string[];
  skipped: { name: string; reason: string }[];
  /** Все вложения со статусом; нет у черновиков до MAIL-UI. */
  files?: { name: string; size: number; inline: boolean; status: 'uploaded' | 'not_uploaded' | 'skipped'; reason: string | null }[];
  error: string | null;
  retryAt: string | null;
  diag?: {
    criteria: { from: string; domain: string | null; since: string; before: string; subject: string | null; windowSource?: 'letter' | 'lead' | 'default' };
    folders: { path: string; inWindow: number; bySender: number; scannedWithoutDate?: number; bySenderWithoutDate?: number }[];
    skippedFolders: string[];
    fallbackWithoutDate: boolean;
    stoppedAfterInbox?: boolean;
    partial?: { where: string; ranges: string[] } | null;
    errors: string[];
  } | null;
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

/** Источник базы знаний опта (RFD-AI-AGENT-OPT-KB): файл, ссылка или текст менеджера. */
export interface KbSourceInfo {
  id: number;
  kind: 'file' | 'url' | 'text';
  title: string;
  original: string | null;
  mime: string | null;
  status: 'new' | 'indexed' | 'error';
  sizeBytes: number;
  chunks: number;
  embeddedChunks: number;
  refreshDays: number | null;
  nextRefreshAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  indexedAt: string | null;
  /** Ссылка-раздел (обход до 50 страниц), родитель для страниц раздела, код последнего ответа сервера. */
  crawl: boolean;
  parentId: number | null;
  httpStatus: number | null;
  /** Состояние задания очереди kb-index; null — не в очереди. */
  job?: DraftJob;
}

export interface KbUsageInfo {
  sources: number;
  bytes: number;
  chunks: number;
  limits: { bytes: number; chunks: number };
}

export interface KbChunkInfo {
  id: number;
  sourceId: number;
  position: number;
  text: string;
  meta: { page?: number; sheet?: string; heading?: string };
  hasEmbedding: boolean;
}

export interface KbHitInfo {
  chunkId: number;
  sourceId: number;
  position: number;
  text: string;
  meta: KbChunkInfo['meta'];
  score: number;
  matched: ('vector' | 'text')[];
  source: { title: string; kind: KbSourceInfo['kind']; original: string | null; indexedAt: string | null } | null;
}

/** Запись цены базы знаний (kb_prices). */
export interface KbPriceInfo {
  id: number;
  sourceId: number | null;
  model: string;
  modelKey: string;
  factory: string | null;
  unit: string;
  baseSize: string | null;
  widthMm: number | null;
  heightMm: number | null;
  price: number;
  vat: 'included' | 'no_vat' | 'unknown';
  validAt: string;
  confidence: number;
  origin: 'price_list' | 'web' | 'manager' | 'purchase';
  nonstandard: { heightPct?: number; heightOverMm?: number; widthPct?: number; widthOverMm?: number; thicknessPct?: number; doubleLeafPct?: number; areaScale?: boolean };
  url: string | null;
  note: string | null;
  createdAt: string;
  sourceTitle: string | null;
  sourceKind: 'file' | 'url' | 'text' | null;
}

export interface KbAnswerInfo {
  question: string;
  answer: string | null;
  sources: { n: number; chunkId: number; sourceId: number; label: string; excerpt: string }[];
  reason: string | null;
  cost: { inputTokens: number; outputTokens: number; usd: number };
  provider: string | null;
  model: string | null;
  ms: number;
}

export interface KbAliasInfo {
  id: number;
  alias: string;
  canonical: string;
}

export interface ColumnMappingInfo {
  sheet: string | null;
  model: number;
  price: number;
  size: number | null;
  width: number | null;
  height: number | null;
  factory: number | null;
  unit: number | null;
  headerRow: number | null;
}

export interface PriceListPreviewInfo {
  sheets: string[];
  columns: { index: number; header: string; sample: string[] }[];
  mapping: ColumnMappingInfo;
  headerFound: boolean;
  sample: { sheet: string; row: number; model: string; factory: string | null; unit: string; widthMm: number | null; heightMm: number | null; price: number; section: string | null }[];
  total: number;
  skipped: number;
}

export interface PriceImportBody {
  mapping: Partial<ColumnMappingInfo>;
  factory?: string;
  validAt?: string;
  vat?: KbPriceInfo['vat'];
  nonstandard?: KbPriceInfo['nonstandard'];
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
  /** Поиск цен: все позиции без цены ('all') или одна позиция; force — «искать заново» мимо кэша. */
  research = (draftId: number, requestIndexes: number[] | 'all' = 'all', force = false) => this.call<{ queued: number[]; reason?: string }>('POST', '/widget/v1/kp/research', { draftId, requestIndexes, force });
  researchState = (draftId: number) => this.call<ResearchState>('GET', `/widget/v1/kp/research?draftId=${draftId}`);
  sendPreview = (draftId: number) => this.call<SendPreviewInfo>('GET', `/widget/v1/kp/send/preview?draftId=${draftId}`);
  /** «Проверено, отправить»: письмо уходит только отсюда. */
  send = (body: { draftId: number; to: string; cc?: string; subject: string; text: string; resendConfirmed?: boolean }) =>
    this.call<{ draft: KpDraftInfo | null; to: string }>('POST', '/widget/v1/kp/send', body);


  /** База знаний: источники, добавление текста и файла (base64 в JSON), переиндексация, удаление, фрагменты, поиск. */
  kbSources = () => this.call<{ sources: KbSourceInfo[]; usage: KbUsageInfo }>('GET', '/widget/v1/kb/sources');
  kbAddText = (title: string, content: string) => this.call<{ source: KbSourceInfo }>('POST', '/widget/v1/kb/sources/text', { title, content });
  kbAddFile = (filename: string, mime: string, contentBase64: string) => this.call<{ source: KbSourceInfo }>('POST', '/widget/v1/kb/sources/file', { filename, mime, contentBase64 });
  /** Ссылка на страницу или файл: refreshDays — период обновления (0 — не обновлять), crawl — обойти раздел до 50 страниц. */
  kbAddUrl = (url: string, refreshDays: number, crawl: boolean) => this.call<{ source: KbSourceInfo; existed: boolean }>('POST', '/widget/v1/kb/sources/url', { url, refreshDays, crawl });
  kbReindex = (id: number) => this.call<{ source: KbSourceInfo }>('POST', `/widget/v1/kb/sources/${id}/reindex`);
  kbRemove = (id: number) => this.call<{ ok: true }>('DELETE', `/widget/v1/kb/sources/${id}`);
  kbChunks = (id: number, limit = 100) => this.call<{ source: KbSourceInfo; chunks: KbChunkInfo[] }>('GET', `/widget/v1/kb/sources/${id}/chunks?limit=${limit}`);
  kbSearch = (q: string, limit = 5) => this.call<{ query: string; hits: KbHitInfo[]; model: string | null; tokens: number; costUsd: number; ms: number }>('GET', `/widget/v1/kb/search?q=${encodeURIComponent(q)}&limit=${limit}`);

  /** Цены и синонимы базы знаний (этап 3). */
  kbPricePreview = (sourceId: number, mapping?: Partial<ColumnMappingInfo>) => this.call<PriceListPreviewInfo>('GET', `/widget/v1/kb/sources/${sourceId}/prices/preview${mapping ? `?mapping=${encodeURIComponent(JSON.stringify(mapping))}` : ''}`);
  kbPriceImport = (sourceId: number, body: PriceImportBody) => this.call<{ imported: number; skipped: number }>('POST', `/widget/v1/kb/sources/${sourceId}/prices/import`, body);
  kbPrices = (q = '', limit = 200) => this.call<{ items: KbPriceInfo[]; total: number }>('GET', `/widget/v1/kb/prices?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  kbAddPrice = (body: { model: string; factory?: string | null; widthMm?: number | null; heightMm?: number | null; price: number; vat?: KbPriceInfo['vat']; validAt?: string; origin?: KbPriceInfo['origin']; note?: string | null }) => this.call<{ price: KbPriceInfo }>('POST', '/widget/v1/kb/prices', body);
  kbRemovePrice = (id: number) => this.call<{ ok: true }>('DELETE', `/widget/v1/kb/prices/${id}`);
  kbPricesExport = () => this.call<{ filename: string; rows: number; contentBase64: string }>('GET', '/widget/v1/kb/prices/export');
  /** Ответ на вопрос покупателя из базы знаний (этап 4): top-5 фрагментов, модель отвечает со ссылками [n]. */
  kbAnswer = (question: string, leadId?: number) => this.call<KbAnswerInfo>('POST', '/widget/v1/kb/answer', { question, ...(leadId ? { leadId } : {}) });
  kbAliases = () => this.call<{ aliases: KbAliasInfo[] }>('GET', '/widget/v1/kb/aliases');
  kbAddAliases = (lines: string) => this.call<{ added: number; aliases: KbAliasInfo[] }>('POST', '/widget/v1/kb/aliases', { lines });
  kbRemoveAlias = (id: number) => this.call<{ ok: true }>('DELETE', `/widget/v1/kb/aliases/${id}`);

  kpSettings = () => this.call<KpSettingsInfo>('GET', '/widget/v1/kp/settings');
  saveKpSettings = (patch: { constants?: KpConstants; certsDir?: string | null; numbering?: { prefix?: string; counter?: number } }) =>
    this.call<{ ok: true }>('PUT', '/widget/v1/kp/settings', patch);
  uploadTemplate = (filename: string, contentBase64: string) =>
    this.call<{ ok: true; md5: string; size: number }>('POST', '/widget/v1/kp/template', { filename, contentBase64 });
}
