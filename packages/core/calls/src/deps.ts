import type { TokenService } from '@core/amo';
import type { AccountsRepo, JournalRepo, WidgetSettings } from '@core/db';
import type { ChatRoute, LlmGateway, PricingOverrides } from '@core/llm';
import type { Alerter } from '@core/shared';
import type { CallsRepo, DaySummariesRepo } from './repo.ts';

/** Настройки звонков — блок calls настроек виджета розницы. */
export type CallsSettings = WidgetSettings['calls'];

/** Модель для итога дня: шлюз, маршрут и тарифы аккаунта (воркер собирает из настроек виджета). */
export interface CallsLlm {
  llm: LlmGateway;
  route: ChatRoute;
  pricing: PricingOverrides;
  usdRubRate: number;
}

/**
 * Зависимости модуля звонков (RFD-AI-AGENT-CALLS-RETAIL): БД розницы, токены её интеграции amoCRM, журнал, файлы на
 * томе, ключи расшифровки, алерты. Сетевые запросы — через fetch (в тестах подменяется).
 */
export interface CallsDeps {
  calls: CallsRepo;
  days: DaySummariesRepo;
  journal: JournalRepo;
  accounts: Pick<AccountsRepo, 'get'>;
  tokenService: Pick<TokenService, 'getAccessToken'>;
  fetch: typeof fetch;
  /** Корень файлов на томе (MAIL_FILES_ROOT, /data): записи — calls/<аккаунт>/<год-месяц>/. */
  filesRoot: string;
  keys: { speechkit?: string | null; openai?: string | null };
  alerter: Alerter;
  /** Полные настройки виджета аккаунта (блок calls, тарифы). */
  settingsFor(accountId: number): Promise<WidgetSettings>;
  /** Модель аккаунта для итога дня; null — ключа нет. */
  llmFor(accountId: number): Promise<CallsLlm | null>;
  /** Подключённые аккаунты. */
  accountIds(): Promise<number[]>;
  /** RFD-AI-AGENT-CALLS-DAY-FULL: локальные источники общения (таблицы розницы); нет — только звонки и источники amo. */
  sources?: LocalSources;
}

export interface LocalMessage {
  id: string;
  direction: 'in' | 'out';
  author: 'client' | 'manager' | 'agent';
  text: string;
  at: Date;
  /** Канал Wazzup (whatsapp / telegram / max). */
  channel?: string;
  /** RFD-AI-AGENT-WA-FILES: файл сообщения и его извлечённый текст (status: done / skipped / failed / null — ещё не разбирали). */
  file?: { name: string; mime: string | null; text: string | null; status: string | null; error: string | null };
}

/** Вложение письма из mail_attachments с извлечённым текстом. */
export interface LocalMailFile {
  id: string;
  at: Date;
  messageId: string;
  name: string;
  text: string | null;
  status: string;
}

export interface LocalSources {
  /** Wazzup по сделке (lead_id) и телефонам её контактов за период. */
  wazzup?(accountId: number, leadId: number, phones: string[], since: Date, until: Date): Promise<LocalMessage[]>;
  /** Диалог AI-агента (dialog_messages): client — текст из чатов amo и входящих писем, ai — ответы агента, manager — ответы из виджета. */
  dialog?(accountId: number, leadId: number, since: Date, until: Date): Promise<LocalMessage[]>;
  /** Сделки с перепиской за период (Wazzup с lead_id, диалог). */
  activeLeads?(accountId: number, since: Date, until: Date): Promise<number[]>;
  /** Вложения входящих писем по сделке за период (mail_attachments) с извлечённым текстом. */
  mailFiles?(accountId: number, leadId: number, since: Date, until: Date): Promise<LocalMailFile[]>;
}
