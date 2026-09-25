import type { ClientMemory, Suggestion as DbSuggestion, WidgetSettings } from '@ai-door/db';
import type { CalcResult, PricingRules } from '@ai-door/pricing';

export type { CalcResult, PricingRules };
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

export interface LeadPanel {
  leadId: number;
  ai: { enabled: boolean; mode: Mode; paused: boolean; pauseReason: string | null; pausedAt: string | null };
  hints: Suggestion[];
  products: Source[];
  calculations: CalcResult[];
  log: { id: number; kind: string; summary: string; costRub: number; createdAt: string }[];
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
  cost: { usd: number; rub: number; inputTokens: number; outputTokens: number };
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

export interface Dictionaries {
  pipelines: { id: number; name: string; statuses: { id: number; name: string }[] }[];
  taskTypes: { id: number; name: string }[];
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
  addKnowledge = (item: KnowledgeInput) => this.call<{ id: number }>('POST', '/widget/v1/knowledge', item);
  removeKnowledge = (id: number) => this.call<{ ok: true }>('DELETE', `/widget/v1/knowledge/${id}`);
  sandbox = (messages: { role: 'client' | 'ai'; text: string }[], settings?: WidgetSettings) =>
    this.call<SandboxResult>('POST', '/widget/v1/sandbox', settings ? { messages, settings } : { messages });

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

  leadDocuments = (leadId: number) => this.call<{ items: DocumentListItem[] }>('GET', `/widget/v1/leads/${leadId}/documents`);
  analyzeDocument = (leadId: number, body: { name: string; mime: string; file: string; hint?: 'measurement' | 'request' | 'photo' }) =>
    this.call<DocumentResult>('POST', `/widget/v1/leads/${leadId}/documents`, body);

  emailStatus = () =>
    this.call<{ enabled: boolean; hasPassword: boolean; folders: { folder: string; lastOkAt: string | null; lastError: string | null }[] }>(
      'GET',
      '/widget/v1/email/status',
    );
  setEmailPassword = (password: string) => this.call<{ ok: true }>('PUT', '/widget/v1/email/password', { password });
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
