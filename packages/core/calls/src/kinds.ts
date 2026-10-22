import type { JournalKind } from '@core/db';

/** Виды записей журнала по звонкам (объявлены в JournalKind розницы). */
export const CALL_FETCH_KIND: JournalKind = 'call_fetch';
export const CALL_ERROR_KIND: JournalKind = 'call_error';
/** Итог разговоров за день по сделке / контакту: разбор и примечание. */
export const CALL_DAY_KIND: JournalKind = 'call_day';
/** Итог задания calls-day-summary по аккаунту: сделок, звонков, примечаний, ошибок. */
export const CALL_DAY_RUN_KIND: JournalKind = 'call_day_run';
