import type { ClientMemory, Suggestion as DbSuggestion, WidgetSettings } from '@ai-door/db';
import type { ModelInfo, ModelRef, ProviderId } from '@ai-door/llm/types';
import type { CalcResult, PricingRules } from '@ai-door/pricing';

export type { CalcResult, PricingRules, ModelInfo, ModelRef, ProviderId };
export type Suggestion = Omit<DbSuggestion, 'createdAt' | 'decidedAt'> & { createdAt: string; decidedAt: string | null };
import type { AmoWidgetSelf } from './amo.ts';

export type { WidgetSettings };
export type Mode = WidgetSettings['mode'];

export interface CatalogStats {
  products: number;
  lastImport: { status: string; startedAt: string; finishedAt: string | null; products: number | null; error: string | null } | null;
}

export interface Status {
  accountId: number;
  isAdmin: boolean;
  connected: boolean;
  tokenExpiresAt: string | null;
  tokenError: string | null;
  enabled: boolean;
  mode: Mode;
  llmConfigured: boolean;
  /** 1.1.0: провайдер и модель по умолчанию, ключи каких провайдеров есть, здоровье интеграции. */
  llm?: {
    provider: ProviderId;
    model: string;
    fallback: ModelRef | null;
    providers: ProviderId[];
    missingModels: string[];
    lastError: { summary: string; createdAt: string } | null;
  };
  spend: { todayRub: number; monthRub: number };
  dailyLimitRub: number | null;
  catalog: CatalogStats;
}

export interface Source {
  type: 'product' | 'knowledge';
  id: string;
  title: string;
  url?: string | null;
  date?: string;
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

export interface LeadFile {
  id: number;
  name: string;
  type: string | null;
  url: string;
  receivedAt: string;
  status: 'parsed' | 'error' | 'unparsed' | 'pending';
  documentId: number | null;
  kind: string | null;
  summary: string;
  openings: number;
  positions: number;
}

export interface LeadTask {
  id: string;
  kind: string;
  text: string;
  createdAt: string;
  source: 'tool' | 'handoff';
}

export interface LeadProduct extends Source {
  price?: number | null;
  available?: boolean | null;
  picture?: string | null;
  category?: string | null;
}

export interface LeadPanel {
  leadId: number;
  /** 1.1.4: администратор аккаунта amo. Нет у старого бэкенда — тогда переключение модели скрыто. */
  isAdmin?: boolean;
  ai: { enabled: boolean; mode: Mode; paused: boolean; pauseReason: string | null; pausedAt: string | null };
  /** 1.1.0: кто отвечает в этой сделке (с учётом переопределения). Нет у старого бэкенда. */
  llm?: { provider: ProviderId; model: string; fallback: ModelRef | null; override: ModelRef | null; providers: ProviderId[]; configured: boolean };
  health?: { llmConfigured: boolean; dailyLimitExhausted: boolean; lastError: { summary: string; createdAt: string } | null };
  hints: Suggestion[];
  products: LeadProduct[];
  calculations: CalcResult[];
  files?: LeadFile[];
  tasks?: LeadTask[];
  summary?: { text: string; createdAt: string } | null;
  log: { id: number; kind: string; summary: string; costRub: number; createdAt: string; provider?: string; model?: string; fallbackUsed?: boolean }[];
  costRub: number;
}

export interface ToolCall {
  name: string;
  specName: string;
  input: unknown;
  ok: boolean;
  empty: boolean;
  error?: string;
  durationMs: number;
}

export interface SandboxResult {
  kind: 'reply' | 'handoff' | 'blocked';
  text: string | null;
  handoff: { reason: string; summary: string } | null;
  blockedReason: string | null;
  toolCalls: ToolCall[];
  sources: Source[];
  rejections: { kind: string; fragment: string }[][];
  notes: string[];
  tasks: { text: string; taskTypeId: number; deadlineMin: number }[];
  memory: ClientMemory;
  calculation: CalcResult | null;
  model: string;
  provider?: ProviderId;
  requestedModel?: string;
  fallbackUsed?: boolean;
  /** Время ответов модели за ход, мс. */
  latencyMs?: number;
  totalMs?: number;
  cost: { usd: number; rub: number; inputTokens: number; outputTokens: number };
}

export type CompareResult = ({ model: ModelRef } & Partial<SandboxResult> & { error?: string })[];

export interface LlmKeys {
  provider: ProviderId;
  fallbackProvider: ProviderId;
  keys: Record<ProviderId, { saved: boolean; mask: string | null; source: 'account' | 'server' | null }>;
  providers: ProviderId[];
}

export interface LlmModels {
  provider: ProviderId;
  models: ModelInfo[];
  fetchedAt: string | null;
  fromCache: boolean;
  source: 'api' | 'tariff';
  noKey: boolean;
  error?: string;
}

export interface ModelStats {
  provider: string;
  model: string;
  dialogs: number;
  replies: number;
  drafts: number;
  hints: number;
  handoffs: number;
  sandbox: number;
  errors: number;
  fallbacks: number;
  costRub: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  avgCostPerDialogRub: number;
  avgLatencyMs: number | null;
}

export interface EvalReport {
  id: string;
  topic: string;
  passed: boolean;
  failures: string[];
  fabricated: string[];
  final: string;
  handoffReason: string | null;
  costUsd: number;
  latencyMs: number[];
  provider: string;
  model: string;
  fallbackUsed: boolean;
}

export interface EvalSummary {
  total: number;
  passed: number;
  fabricated: number;
  rejections: number;
  costUsd: number;
  avgCostUsd: number;
  p95LatencyMs: number;
  handoffExpected: number;
  handoffOk: number;
  fallbacks: number;
}

export interface EvalRun {
  id: number;
  status: 'running' | 'done' | 'failed';
  models: ModelRef[];
  dialogIds: string[];
  results?: { ref: ModelRef; reports: EvalReport[]; summary: EvalSummary | null; error?: string }[];
  summary: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  progress: { done: number; total: number };
}

export interface KnowledgeItem {
  id: number;
  kind: 'faq' | 'text' | 'url' | 'file';
  title: string;
  source: string | null;
  createdAt: string;
  chunks: number;
}

export type KnowledgeInput =
  | { kind: 'faq'; question: string; answer: string }
  | { kind: 'text'; title: string; content: string }
  | { kind: 'url'; url: string };

export interface DocOpening {
  room: string | null;
  label: string | null;
  width_mm: number | null;
  height_mm: number | null;
  wall_mm: number | null;
  leaf_width_mm: number | null;
  qty: number | null;
  double: boolean | null;
  side: 'left' | 'right' | null;
  note: string | null;
}

export interface DocPosition {
  name: string;
  marking: string | null;
  width_mm: number | null;
  height_mm: number | null;
  qty: number | null;
  unit: string | null;
  price_rub: number | null;
  material: string | null;
  color: string | null;
  fireproof: boolean | null;
  note: string | null;
}

export interface DocumentResult {
  id: number;
  kind: 'measurement' | 'request' | 'estimate' | 'catalog' | 'photo' | 'other';
  data: {
    kind: string;
    title: string;
    summary: string;
    customer_type: 'b2c' | 'b2b' | 'unknown';
    openings: DocOpening[];
    positions: DocPosition[];
    requirements: string[];
    questions: string[];
    photo: { subject: string; door_type: string | null; color: string | null; style: string | null; note: string | null } | null;
  };
  matches: { index: number; products: { id: string; name: string; price: number | null; url: string | null }[]; flags: string[] }[];
  kit: {
    lines: { opening: string; double: boolean; qty: number; leaf_width_mm: number | null; leaf_height_mm: number | null; nonstandard: boolean; boxes: number; casings: number; extensions: number; extension_width_mm: number | null }[];
    totals: { doors: number; boxes: number; casings: number; extensions: number };
  } | null;
  note: string;
  noted: boolean;
  ocr: string | null;
  piiRemoved: number;
  costRub: number;
}

export interface DocumentListItem {
  id: number;
  filename: string | null;
  kind: string;
  source: string;
  title: string;
  summary: string;
  openings: number;
  positions: number;
  createdAt: string;
}

export interface AnalyticsSummary {
  from: string;
  to: string;
  dialogs: number;
  replies: number;
  drafts: number;
  hints: number;
  handoffs: number;
  documents: number;
  errors: number;
  costRub: number;
  avgCostPerDialogRub: number;
  outcomes: { tracked: number; advanced: number; won: number; lost: number; conversionPct: number | null };
  handoffReasons: { reason: string; count: number }[];
  byDay: { day: string; dialogs: number; replies: number; handoffs: number; costRub: number }[];
}

export interface BillingMonth {
  month: string;
  costRub: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  dialogs: number;
  replies: number;
}

export interface SettingsVersion {
  id: number;
  userId: number | null;
  changedAt: string;
  changed: string[];
}

export interface Dictionaries {
  pipelines: { id: number; name: string; statuses: { id: number; name: string }[] }[];
  taskTypes: { id: number; name: string }[];
  /** Пользователи аккаунта — для выбора получателя задач. */
  users?: { id: number; name: string; email: string | null; isActive: boolean; isAdmin: boolean }[];
}

export interface WazzupDumpInfo {
  id: number; status: string; startAt: string; endAt: string; channelId: string | null;
  rowsTotal: number; inserted: number; skipped: number; columns: string | null; error: string | null;
  createdAt: string; finishedAt: string | null;
}

export class WidgetApi {
  constructor(
    private readonly self: AmoWidgetSelf,
    private readonly baseUrl: string,
  ) {}

  status = () => this.call<Status>('GET', '/widget/v1/status');
  settings = () => this.call<{ settings: WidgetSettings; version: number }>('GET', '/widget/v1/settings');
  saveSettings = (settings: WidgetSettings) =>
    this.call<{ settings: WidgetSettings; version: number }>('PUT', '/widget/v1/settings', settings);
  dictionaries = () => this.call<Dictionaries>('GET', '/widget/v1/amo/dictionaries');
  leadPanel = (leadId: number) => this.call<LeadPanel>('GET', `/widget/v1/leads/${leadId}/panel`);
  pause = (leadId: number) => this.call<{ ok: true }>('POST', `/widget/v1/leads/${leadId}/pause`);
  resume = (leadId: number) => this.call<{ ok: true }>('POST', `/widget/v1/leads/${leadId}/resume`);
  journal = (q: { leadId?: number; kind?: string; before?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
    return this.call<{ items: JournalItem[] }>('GET', `/widget/v1/journal${qs.size ? `?${qs}` : ''}`);
  };
  catalog = () => this.call<CatalogStats>('GET', '/widget/v1/catalog');
  importCatalog = () => this.call<{ started: boolean }>('POST', '/widget/v1/catalog/import');
  knowledge = () => this.call<{ items: KnowledgeItem[] }>('GET', '/widget/v1/knowledge');
  addKnowledge = (item: KnowledgeInput) =>
    this.call<{ id: number | null; listing?: boolean; added?: number; skipped?: number; total?: number }>('POST', '/widget/v1/knowledge', item);
  removeKnowledge = (id: number) => this.call<{ ok: true }>('DELETE', `/widget/v1/knowledge/${id}`);
  /** Файл в базу знаний (PDF, DOCX, XLSX, TXT) — содержимое в base64. */
  addKnowledgeFile = (name: string, mime: string, file: string) =>
    this.call<{ id: number; chars: number; pages: number }>('POST', '/widget/v1/knowledge/file', { name, mime, file });
  /** Перечитать статью по ссылке. */
  refreshKnowledge = (id: number) => this.call<{ id: number }>('POST', `/widget/v1/knowledge/${id}/refresh`);
  refreshAllKnowledge = () =>
    this.call<{ ok: number; failed: number }>('POST', '/widget/v1/knowledge/refresh-all');
  sandbox = (messages: { role: 'client' | 'ai'; text: string }[], settings?: WidgetSettings, model?: ModelRef, phone?: string) =>
    this.call<SandboxResult>('POST', '/widget/v1/sandbox', { messages, ...(settings ? { settings } : {}), ...(model ? { model } : {}), ...(phone ? { phone } : {}) });

  pricing = () => this.call<{ rules: PricingRules; version: number }>('GET', '/widget/v1/pricing');
  savePricing = (rules: PricingRules) => this.call<{ rules: PricingRules; version: number }>('PUT', '/widget/v1/pricing', rules);
  importPricing = (fileBase64: string) =>
    this.call<{ rules: PricingRules; saved: boolean }>('POST', '/widget/v1/pricing/import', { file: fileBase64 });
  exportPricing = () => this.call<{ file: string; name: string }>('GET', '/widget/v1/pricing/export');
  testPricing = (body: {
    doors: { product_id: string; width_mm?: number; height_mm?: number; qty: number }[];
    services?: { code: string; km?: number; floor?: number }[];
    extras?: { code: string; qty: number }[];
    rules?: PricingRules;
  }) => this.call<{ result: CalcResult; text: string }>('POST', '/widget/v1/pricing/test', body);
  suggestions = (leadId?: number) =>
    this.call<{ items: Suggestion[] }>('GET', `/widget/v1/suggestions${leadId ? `?leadId=${leadId}` : ''}`);
  approve = (id: number, text?: string) => this.call<{ ok: true }>('POST', `/widget/v1/suggestions/${id}/approve`, text ? { text } : {});
  reject = (id: number) => this.call<{ ok: true }>('POST', `/widget/v1/suggestions/${id}/reject`);
  markUsed = (id: number) => this.call<{ ok: true }>('POST', `/widget/v1/suggestions/${id}/used`);
  summary = (leadId: number) => this.call<{ text: string; costRub: number }>('POST', `/widget/v1/leads/${leadId}/summary`);

  analytics = (days: number) => this.call<AnalyticsSummary>('GET', `/widget/v1/analytics?days=${days}`);
  billing = () => this.call<{ months: BillingMonth[] }>('GET', '/widget/v1/billing');
  settingsHistory = () => this.call<{ items: SettingsVersion[] }>('GET', '/widget/v1/settings/history');
  settingsVersion = (id: number) => this.call<SettingsVersion & { settings: WidgetSettings }>('GET', `/widget/v1/settings/history/${id}`);
  restoreSettings = (id: number) => this.call<{ version: number }>('POST', `/widget/v1/settings/history/${id}/restore`);
  llmStatus = () => this.call<{ hasOwnKey: boolean; configured: boolean; source: 'account' | 'server' | null }>('GET', '/widget/v1/llm/status');
  llmKeys = () => this.call<LlmKeys>('GET', '/widget/v1/llm/keys');
  // Anthropic — провайдер по умолчанию: тело и адрес как в 1.0.x (совместимость с бэкендом 1.0.x).
  setLlmKey = (key: string, provider: ProviderId = 'anthropic') => this.call<{ ok: true }>('PUT', '/widget/v1/llm/key', provider === 'anthropic' ? { key } : { key, provider });
  deleteLlmKey = (provider: ProviderId = 'anthropic') => this.call<{ ok: true }>('DELETE', `/widget/v1/llm/key${provider === 'anthropic' ? '' : `?provider=${provider}`}`);
  testLlmKey = (key?: string, provider: ProviderId = 'anthropic') =>
    this.call<{ ok: true; models: string[] } | { ok: false; error: string }>('POST', '/widget/v1/llm/test', { ...(key ? { key } : {}), ...(provider === 'anthropic' ? {} : { provider }) });
  llmModels = (provider: ProviderId, refresh = false) => this.call<LlmModels>('GET', `/widget/v1/llm/models?provider=${provider}${refresh ? '&refresh=1' : ''}`);
  setLeadModel = (leadId: number, model: ModelRef | null) => this.call<{ ok: true }>('PUT', `/widget/v1/leads/${leadId}/llm`, { model });
  sandboxCompare = (messages: { role: 'client' | 'ai'; text: string }[], models: ModelRef[], settings?: WidgetSettings) =>
    this.call<{ results: CompareResult }>('POST', '/widget/v1/sandbox/compare', settings ? { messages, models, settings } : { messages, models });
  evalDialogs = () => this.call<{ items: { id: string; topic: string; turns: number }[] }>('GET', '/widget/v1/evals/dialogs');
  runEval = (models: ModelRef[], opts: { ids?: string[]; limit?: number } = {}) => this.call<{ id: number }>('POST', '/widget/v1/evals/run', { models, ...opts });
  evalRuns = () => this.call<{ items: EvalRun[] }>('GET', '/widget/v1/evals/runs');
  evalRun = (id: number) => this.call<EvalRun>('GET', `/widget/v1/evals/runs/${id}`);
  analyticsModels = (days: number) => this.call<{ items: ModelStats[] }>('GET', `/widget/v1/analytics/models?days=${days}`);
  analyzeChatFile = (leadId: number, fileId: number) => this.call<DocumentResult>('POST', `/widget/v1/leads/${leadId}/files/${fileId}/analyze`);
  addLeadNote = (leadId: number, text: string) => this.call<{ ok: true }>('POST', `/widget/v1/leads/${leadId}/notes`, { text });
  purgeAccount = () => this.call<{ ok: true }>('POST', '/widget/v1/account/purge', { confirm: 'УДАЛИТЬ' });

  leadDocuments = (leadId: number) => this.call<{ items: DocumentListItem[] }>('GET', `/widget/v1/leads/${leadId}/documents`);
  analyzeDocument = (leadId: number, body: { name: string; mime: string; file: string; hint?: 'measurement' | 'request' | 'photo' }) =>
    this.call<DocumentResult>('POST', `/widget/v1/leads/${leadId}/documents`, body);

  emailStatus = () =>
    this.call<{ enabled: boolean; hasPassword: boolean; folders: { folder: string; lastOkAt: string | null; lastError: string | null }[] }>(
      'GET',
      '/widget/v1/email/status',
    );
  setEmailPassword = (password: string) => this.call<{ ok: true }>('PUT', '/widget/v1/email/password', { password });
  wazzupStatus = () =>
    this.call<{
      hasKey: boolean;
      webhookUri: string;
      state: { webhookUri: string | null; subscribedAt: string | null; lastEventAt: string | null; eventsTotal: number; lastError: string | null; lastErrorAt: string | null };
      stats: { total: number; last24h: number; phones: number };
    }>('GET', '/widget/v1/wazzup/status');
  wazzupGroups = () =>
    this.call<{
      items: { chatId: string; chatName: string | null; chatType: string | null; messages: number; lastAt: string | null; skipped: number }[];
    }>('GET', '/widget/v1/wazzup/groups');
  setWazzupKey = (apiKey: string) => this.call<{ ok: true }>('PUT', '/widget/v1/wazzup/key', { apiKey });
  testWazzup = () =>
    this.call<{ ok: boolean; error?: string; channels?: { id: string | null; transport: string | null; name: string | null; state: string | null }[] }>('POST', '/widget/v1/wazzup/test');
  subscribeWazzup = () => this.call<{ ok: boolean; error?: string; webhookUri?: string }>('POST', '/widget/v1/wazzup/subscribe');
  wazzupSubscription = () => this.call<{ ok: boolean; error?: string; current?: unknown }>('GET', '/widget/v1/wazzup/subscription');
  wazzupDump = (startAt: string, endAt: string, channelId?: string) =>
    this.call<{ ok: boolean; dump: WazzupDumpInfo }>('POST', '/widget/v1/wazzup/dump', { startAt, endAt, ...(channelId ? { channelId } : {}) });
  wazzupDumps = () => this.call<{ ok: boolean; dumps: WazzupDumpInfo[] }>('GET', '/widget/v1/wazzup/dumps');
  testEmail = () => this.call<{ imap: string; smtp: string; sentFolder: string | null }>('POST', '/widget/v1/email/test');

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
