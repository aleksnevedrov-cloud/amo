import type { CallAnalysis } from './analyze.ts';
import { mmss } from './analyze.ts';
import type { AmoRaw } from './notes.ts';
import type { CallRow } from './repo.ts';

/**
 * RFD-AI-AGENT-OPT-CALLS, этап 3: одно обычное примечание «Анализ звонка» в сделку (нет сделки — в контакт).
 * Оценка менеджера в примечание входит по ТЗ этапов 2–3 (строка «Оценка менеджера: N/10 — …»). Задачи не ставятся.
 */

const MSK = 'Europe/Moscow';

/** Дата и время звонка по Москве: ДД.ММ.ГГГГ ЧЧ:ММ. */
export function callDateTime(d: Date): string {
  const p = new Intl.DateTimeFormat('ru-RU', { timeZone: MSK, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('day')}.${g('month')}.${g('year')} ${g('hour')}:${g('minute')}`;
}

/** Текст примечания по формату ТЗ п. 3; дата — фактическое время звонка (важно для догрузки старых записей). */
export function formatCallNote(call: Pick<CallRow, 'calledAt' | 'direction' | 'durationSec'>, a: CallAnalysis, durationSec = call.durationSec): string {
  const agreements = a.agreements.map((x) => x.trim()).filter(Boolean);
  return [
    `Анализ звонка ${callDateTime(call.calledAt)}, ${call.direction === 'in' ? 'входящий' : 'исходящий'}, ${mmss(durationSec)}`,
    `Итог: ${a.summary.trim() || '—'}`,
    `Договорённости: ${agreements.length ? (agreements.length === 1 ? agreements[0] : agreements.map((x) => `\n— ${x}`).join('')) : 'нет'}`,
    `Следующий шаг: ${a.nextStep.trim() || 'не определён'}`,
    `Оценка менеджера: ${a.managerScore}/10 — ${a.managerComment.trim() || '—'}`,
  ].join('\n');
}

export interface PostedNote {
  noteId: number;
  entity: 'lead' | 'contact';
  entityId: number;
  at: string;
  text: string;
}

/** Создать примечание: в сделку, если звонок к ней привязан, иначе в контакт (или сущность примечания-звонка). */
export async function postCallNote(amo: AmoRaw, call: Pick<CallRow, 'leadId' | 'entity' | 'entityId'>, text: string, now = new Date()): Promise<PostedNote> {
  const entity: 'lead' | 'contact' = call.leadId ? 'lead' : call.entity === 'lead' ? 'lead' : 'contact';
  const entityId = call.leadId ?? call.entityId;
  const res = await amo.post<{ _embedded?: { notes?: { id: number }[] } }>(`/api/v4/${entity === 'lead' ? 'leads' : 'contacts'}/${entityId}/notes`, [{ note_type: 'common', params: { text } }]);
  const noteId = res?._embedded?.notes?.[0]?.id ?? 0;
  if (!noteId) throw new Error(`amo не вернул id примечания (${entity} ${entityId})`);
  return { noteId, entity, entityId, at: now.toISOString(), text };
}
