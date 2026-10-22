import type { JournalKind } from '@core/db';

/** Виды записей журнала по звонкам; в общий JournalKind (packages/core) не добавляются — ядро не меняем. */
export const CALL_FETCH_KIND = 'call_fetch' as JournalKind;
export const CALL_ERROR_KIND = 'call_error' as JournalKind;
export const CALL_ANALYSIS_KIND = 'call_analysis' as JournalKind;
export const CALL_NOTE_KIND = 'call_note' as JournalKind;
