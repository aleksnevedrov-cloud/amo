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
  // KP-AGENT-V2: ставка НДС (по умолчанию 22) и срок действия цены; пусто — вопрос в опроснике.
  vatRate?: number;
  priceValidity?: string;
};

/** ГОСТ-профиль двери (KP-AGENT-V2, п. 3): поля разбора обозначения; null — не указано. */
export interface GostProfileInfo {
  gost: string | null;
  kind: string | null;
  leaves: number | null;
  unequal: boolean;
  opening: 'left' | 'right' | null;
  fill: 'Г' | 'О' | null;
  threshold: string | null;
  strength: string | null;
  fire: string | null;
  heightMm: number | null;
  widthMm: number | null;
  basis: 'leaf' | 'frame' | 'opening' | null;
  material: string | null;
  cover: string | null;
  brand: string | null;
}

/** Цены интернета по позиции (п. 4.2): min / медиана / max, источники; в КП сами не ставятся — выбирает менеджер. */
export interface KpLineWebInfo {
  query: string;
  researchedAt: string;
  min: number;
  median: number;
  max: number;
  count: number;
  factorySources: number;
  spreadPct: number;
  enough: boolean;
  sources: { url: string; seller: string; price: number; unitPrice: number | null; foundAt: string; manufacturer: boolean; site: string | null }[];
  excludedSites: string[];
}

export type QuestionType = 'incomplete' | 'model_choice' | 'analog' | 'web_price' | 'enter_price' | 'nonstandard' | 'component_door' | 'photo' | 'delivery' | 'price_validity';

export interface KpAnswerInfo {
  option: string | null;
  price?: number | null;
  fields?: Record<string, string>;
  at: string;
  by: number | null;
}

/** Вопрос опросника менеджеру (п. 5): выводится сервером из черновика; blocking — без ответа КП не собирается. */
export interface KpQuestionInfo {
  key: string;
  type: QuestionType;
  blocking: boolean;
  title: string;
  text: string;
  requestIndexes: number[];
  options: { id: string; label: string; detail?: string | null; price?: number | null }[];
  fields?: { name: string; label: string; value: string | null }[];
  customPrice?: boolean;
  web?: KpLineWebInfo | null;
  /** Текст уточнения для клиента — менеджер отправляет сам. */
  askClient: string | null;
  answer: KpAnswerInfo | null;
}

export interface KpAnswerBody {
  key: string;
  option?: string | null;
  price?: number | null;
  fields?: Record<string, string>;
}

/** Кандидат в прайс (п. 4.4): цена, подтверждённая менеджером в КП; в подбор не идёт. */
export interface KbCandidateInfo {
  id: number;
  leadId: number | null;
  draftId: number | null;
  model: string;
  size: string | null;
  price: number;
  source: 'web_confirmed' | 'manager';
  url: string | null;
  note: string | null;
  createdAt: string;
}

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
  priceSource?: 'research' | 'analog' | 'manager' | 'kb' | 'price_file' | 'web_confirmed';
  market?: { median: number; min: number; max: number; count: number; unit: 'piece'; researchId: number; researchedAt: string } | null;
  coefficient?: number;
  /** Подпись источника цены в плитке: «по базе: прайс Текона (01.10.2026)», «по закупке», «по рынку», «изменено менеджером». */
  priceLabel?: string | null;
  /** Срок актуальности вышел — «цена устарела». */
  priceStale?: boolean;
  kbPriceId?: number | null;
  /** service — работы и услуги: после товаров под заголовком, без размера и без поиска цены (XLSX-2). */
  kind?: 'product' | 'service';
  /** Категория позиции (KB-COMPONENTS): дверь / комплектующее / фурнитура / работы; работы — «по замеру», цена не требуется. */
  category?: 'door' | 'component' | 'hardware' | 'service';
  /** Модель и покрытие строки прайса («ДВ CPL 0,2 мм») и комплектация — показываются под полным названием (KP-NAME). */
  priceModel?: string | null;
  equipment?: string | null;
  /** Комплектация из раздела ТЗ клиента (Word-файл заявки, KP-DOCX-APPENDIX). */
  tzEquipment?: string | null;
  /** Сокращение по ГОСТ из строки прайса — в строку «обозначение» (KP-LAYOUT). */
  priceAbbr?: string | null;
  /**
   * KB-PRICE-SHEETS: included — входит в цену блока двери (в таблицу и итог КП не идёт); not_priced — в прайсе цены нет
   * («уточнить у менеджера», не 0 ₽); estimate — сметная цена.
   */
  priceOutcome?: 'priced' | 'included' | 'not_priced' | 'estimate' | 'question';
  /** Примечания под позицией в КП (вкладка «Подбор», нестандарт). */
  quoteNotes?: string[];
  /** ID товара прайса двери (INT-013) — контекст для комплектующих и фурнитуры ниже. */
  productId?: string | null;
  /** priceOutcome = included: ID двери или название комплекта, в который входит позиция. */
  includedIn?: string | null;
  /** KB-COMPONENT-DOOR: дверь заявки (request_index), к которой менеджер отнёс комплектующее. */
  componentDoor?: number | null;
  /** KB-COMPONENT-DOOR-GROUP: дверь выбрана для этой строки (line) или ответом на группу (group). */
  componentDoorBy?: 'line' | 'group' | null;
  componentDoorGroup?: string | null;
  /** KP-AGENT-V2: ГОСТ-профиль двери и обозначение по ГОСТ; цены интернета; исключена в опроснике. */
  gostProfile?: GostProfileInfo | null;
  gostDesignation?: string | null;
  web?: KpLineWebInfo | null;
  excluded?: boolean;
  /** Вопрос «К какой двери считать …?» со списком дверей заявки; пока он есть — без цены, документ не собирается. */
  question?: { kind: 'component_door'; text: string; reason: 'many' | 'none'; group?: string; groupTitle?: string; options: { requestIndex: number; productId: string | null; model: string; size: string; qty: number }[] } | null;
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
  /** KP-AGENT-V2: опросник, счётчики для узкой колонки и шапки окна, доставка, срок действия цены, требования, фото, текст письма. */
  survey?: KpQuestionInfo[];
  counters?: { positions: number; open: number; blocking: number; unpriced: number };
  delivery?: { mode: 'delivery' | 'pickup'; address: string | null; sum: number | null } | null;
  priceValidity?: string | null;
  vatRate?: number;
  requirements?: string[];
  photos?: { name: string; requestIndex?: number | null; ignored?: boolean }[];
  letterText?: string | null;
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
  /** Цен из этого источника в базе (прайс импортируется автоматически, KB-PRICELIST). */
  prices?: number;
  /** KB-MULTIPRICE: ключ прайса, короткое название и итог последнего импорта. */
  priceKey?: string | null;
  priceTitle?: string | null;
  priceImport?: { title: string; updated: boolean; was: number; imported: number; removed: number; added: number; at: string; book?: KbBookCounts | null; error?: string | null } | null;
  /** KB-PRICE-SHEETS: счётчики многолистового прайса для карточки файла; null — старый одностраничный прайс или не прайс. */
  counts?: { doors: number; components: number; hardware: number; sizes: number; aliases: number; comments: number; dictionary: number } | null;
  /** KP-AGENT-V2, п. 4а: у сайта — комментарий (что на нём есть / чего нет) и отметка «фабрика». */
  comment?: string | null;
  isFactory?: boolean;
}

/** Итог импорта многолистового прайса (KB-PRICE-SHEETS): по вкладкам. */
export interface KbBookCounts {
  doors: number;
  components: number;
  hardware: number;
  hardwareUnpriced: number;
  estimates: number;
  sizes: number;
  aliases: number;
  comments: number;
  dictionary: number;
  skipped: string[];
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
  /** null — в прайсе цены нет (тариф «Дополнений», KB-HW-NULL). */
  price: number | null;
  vat: 'included' | 'no_vat' | 'unknown';
  validAt: string;
  confidence: number;
  origin: 'price_list' | 'web' | 'manager' | 'purchase';
  nonstandard: { heightPct?: number; heightOverMm?: number; widthPct?: number; widthOverMm?: number; thicknessPct?: number; doubleLeafPct?: number; areaScale?: boolean };
  url: string | null;
  note: string | null;
  createdAt: string;
  sourceTitle: string | null;
  /** Ключ и короткое название прайса-файла (KB-MULTIPRICE): «Межкомнатные»; у веб-цен и правок — null. */
  priceKey?: string | null;
  priceTitle?: string | null;
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
  abbr: number | null;
  description: number | null;
}

export interface PriceListPreviewInfo {
  sheets: string[];
  columns: { index: number; header: string; sample: string[] }[];
  mapping: ColumnMappingInfo;
  headerFound: boolean;
  sample: { sheet: string; row: number; model: string; factory: string | null; unit: string; widthMm: number | null; heightMm: number | null; price: number; section: string | null; abbr?: string | null; description?: string | null }[];
  total: number;
  skipped: number;
  /** НДС по заголовку колонки цены и признак «файл распознан как прайс» (KB-PRICELIST). */
  vatHint?: 'included' | 'no_vat' | 'unknown';
  isPriceList?: boolean;
  /** KB-PRICE-SHEETS-FIX, п. 3: многолистовой прайс — вместо разметки колонок разбор вкладок: счётчики, ошибки, пропущенное. */
  isPriceBook?: boolean;
  book?: KbBookCounts & { errors: string[] };
  priceImport?: KbSourceInfo['priceImport'];
}

export interface PriceImportBody {
  /** У многолистового прайса разметка не нужна — пустой объект. */
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
  /** KB-COMPONENT-DOOR: ответ менеджера — к какой двери заявки считать комплектующее. */
  /** KB-COMPONENT-DOOR-GROUP: ответ на группу похожих комплектующих — ко всем её строкам. */
  componentDoorGroup = (draftId: number, groupKey: string, doorRequestIndex: number) => this.call<{ draft: KpDraftInfo | null; applied: number }>('POST', `/widget/v1/kp/draft/${draftId}/component-door`, { groupKey, doorRequestIndex });
  componentDoor = (draftId: number, requestIndex: number, doorRequestIndex: number) => this.call<{ draft: KpDraftInfo | null }>('POST', `/widget/v1/kp/draft/${draftId}/component-door`, { requestIndex, doorRequestIndex });
  saveDraftItems = (id: number, items: KpDraftLine[]) => this.call<{ draft: KpDraftInfo | null }>('PUT', `/widget/v1/kp/draft/${id}`, { items });
  /** Кнопка «Собрать документ»: DOCX по шаблону и PDF, файлы уходят в карточку сделки. */
  buildDoc = (draftId: number) => this.call<{ draft: KpDraftInfo | null; pdf: boolean; attached: string[]; files?: { kind: 'docx' | 'pdf'; name: string; bytes: number }[] }>('POST', '/widget/v1/kp/build', { draftId });
  /** Подписанная ссылка на файл КП (10 минут): по ней браузер скачивает PDF/DOCX как вложение (RFD-AI-AGENT-OPT-KP-DOWNLOAD). */
  fileLink = (draftId: number, kind: 'pdf' | 'docx') => this.call<{ url: string; filename: string; expiresAt: string }>('GET', `/widget/v1/kp/file/link?draftId=${draftId}&kind=${kind}`);
  /** Ответ на вопрос опросника (KP-AGENT-V2, п. 5): вариант, своя цена или поля. */
  answer = (draftId: number, body: KpAnswerBody) => this.call<{ draft: KpDraftInfo | null }>('POST', `/widget/v1/kp/draft/${draftId}/answer`, body);
  /** Цены: прайс → интернет по правилам → вопрос; все позиции без цены ('all') или явный список. */
  research = (draftId: number, requestIndexes: number[] | 'all' = 'all') => this.call<{ queued: number[]; total?: number; batches?: number; reason?: string }>('POST', '/widget/v1/kp/research', { draftId, requestIndexes });
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
  kbPriceImport = (sourceId: number, body: PriceImportBody) => this.call<{ imported: number; skipped: number; replaced: number; book?: KbBookCounts | null; counts?: KbSourceInfo['counts'] }>('POST', `/widget/v1/kb/sources/${sourceId}/prices/import`, body);
  kbPrices = (q = '', limit = 200) => this.call<{ items: KbPriceInfo[]; total: number }>('GET', `/widget/v1/kb/prices?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  kbAddPrice = (body: { model: string; factory?: string | null; widthMm?: number | null; heightMm?: number | null; price: number; vat?: KbPriceInfo['vat']; validAt?: string; origin?: KbPriceInfo['origin']; note?: string | null }) => this.call<{ price: KbPriceInfo }>('POST', '/widget/v1/kb/prices', body);
  kbRemovePrice = (id: number) => this.call<{ ok: true }>('DELETE', `/widget/v1/kb/prices/${id}`);
  kbPricesExport = () => this.call<{ filename: string; rows: number; contentBase64: string }>('GET', '/widget/v1/kb/prices/export');
  /** Ответ на вопрос покупателя из базы знаний (этап 4): top-5 фрагментов, модель отвечает со ссылками [n]. */
  kbAnswer = (question: string, leadId?: number) => this.call<KbAnswerInfo>('POST', '/widget/v1/kb/answer', { question, ...(leadId ? { leadId } : {}) });
  /** Сайты (п. 4а): комментарий и «фабрика»; выгрузка и загрузка списка xlsx. Кандидаты в прайс (п. 4.4). */
  kbSetSite = (id: number, body: { comment?: string | null; isFactory?: boolean }) => this.call<{ source: KbSourceInfo }>('PUT', `/widget/v1/kb/sources/${id}/site`, body);
  kbSitesExport = () => this.call<{ filename: string; rows: number; contentBase64: string }>('GET', '/widget/v1/kb/sites/export');
  kbSitesImport = (contentBase64: string) => this.call<{ added: number; updated: number; rows: number }>('POST', '/widget/v1/kb/sites/import', { contentBase64 });
  kbCandidates = () => this.call<{ items: KbCandidateInfo[] }>('GET', '/widget/v1/kb/candidates');
  kbCandidatesExport = () => this.call<{ filename: string; rows: number; contentBase64: string }>('GET', '/widget/v1/kb/candidates/export');
  kbRemoveCandidate = (id: number) => this.call<{ ok: true }>('DELETE', `/widget/v1/kb/candidates/${id}`);
  kbAliases = () => this.call<{ aliases: KbAliasInfo[] }>('GET', '/widget/v1/kb/aliases');
  kbAddAliases = (lines: string) => this.call<{ added: number; aliases: KbAliasInfo[] }>('POST', '/widget/v1/kb/aliases', { lines });
  kbRemoveAlias = (id: number) => this.call<{ ok: true }>('DELETE', `/widget/v1/kb/aliases/${id}`);

  kpSettings = () => this.call<KpSettingsInfo>('GET', '/widget/v1/kp/settings');
  saveKpSettings = (patch: { constants?: KpConstants; certsDir?: string | null; numbering?: { prefix?: string; counter?: number } }) =>
    this.call<{ ok: true }>('PUT', '/widget/v1/kp/settings', patch);
  uploadTemplate = (filename: string, contentBase64: string) =>
    this.call<{ ok: true; md5: string; size: number }>('POST', '/widget/v1/kp/template', { filename, contentBase64 });
}
