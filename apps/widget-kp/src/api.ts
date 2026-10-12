import type { KpConstants, KpDraftStatus } from '@ai-door/db';
import { ApiClient } from '@ai-door/widget-core';

export type { KpConstants };

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
  candidates: {
    request_index: number;
    page_id: string;
    title: string;
    price: number | null;
    available: boolean | null;
    lead_time: string;
    factory: string;
    url: string | null;
  }[];
  items: KpDraftLine[];
  components: { request_index: number; page_id: string; groups: Record<string, { name: string; price: number }[]> }[];
  requiredBlocks: string[];
  questions: string[];
  needsManager: { request_index: number; reason: string }[];
}

export interface KpSettingsInfo {
  constants: KpConstants;
  certsDir: string | null;
  numbering: { prefix: string; year: number | null; counter: number };
  template: { exists: boolean; name: string | null; md5: string | null; updatedAt: string | null };
}

/** Клиент бэкенда виджета «АИ-агент КП»: тот же сервер, что у агента, маршруты /widget/v1/kp/*. */
export class KpApi extends ApiClient {
  /** Черновик КП по сделке (тема RFD-AI-AGENT-KP). */
  draft = (leadId: number) => this.call<{ draft: KpDraftInfo | null }>('GET', `/widget/v1/kp/draft?leadId=${leadId}`);
  /** Кнопка «Подготовить КП»: единственный шаг, который тратит токены. */
  makeDraft = (leadId: number) => this.call<{ draft: KpDraftInfo | null }>('POST', '/widget/v1/kp/draft', { leadId });
  /** Правки менеджера в таблице позиций. */
  saveDraftItems = (id: number, items: KpDraftLine[]) =>
    this.call<{ draft: KpDraftInfo | null }>('PUT', `/widget/v1/kp/draft/${id}`, { items });
  /** Кнопка «Собрать КП»: DOCX по шаблону и PDF, файлы уходят в карточку сделки. */
  buildDoc = (draftId: number) =>
    this.call<{ draft: KpDraftInfo | null; pdf: boolean; attached: string[] }>('POST', '/widget/v1/kp/build', { draftId });
  /** Кнопка «Отправить»: письмо с КП в ту же цепочку, задача на контроль через 2 рабочих дня. */
  send = (draftId: number) =>
    this.call<{ draft: KpDraftInfo | null; to: string; attachments: string[] }>('POST', '/widget/v1/kp/send', { draftId });
  settings = () => this.call<KpSettingsInfo>('GET', '/widget/v1/kp/settings');
  saveSettings = (patch: { constants?: KpConstants; certsDir?: string | null; numbering?: { prefix?: string; counter?: number } }) =>
    this.call<{ ok: true }>('PUT', '/widget/v1/kp/settings', patch);
  uploadTemplate = (filename: string, contentBase64: string) =>
    this.call<{ ok: true; md5: string; size: number }>('POST', '/widget/v1/kp/template', { filename, contentBase64 });
}
