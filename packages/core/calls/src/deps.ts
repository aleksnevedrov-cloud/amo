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
}
