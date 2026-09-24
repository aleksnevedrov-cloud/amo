import { z } from 'zod';
import type { Db } from './pool.ts';

/** Память о клиенте (раздел 9 ТЗ): размеры, бюджет, предпочтения, модели. */
export const memorySchema = z.object({
  openings: z
    .array(
      z.object({
        room: z.string().max(100).optional(),
        width_mm: z.number().int().min(300).max(3000).optional(),
        height_mm: z.number().int().min(1000).max(3500).optional(),
        wall_mm: z.number().int().min(50).max(1000).optional(),
        qty: z.number().int().min(1).max(100).optional(),
      }),
    )
    .max(50)
    .default([]),
  budget_rub: z.number().positive().nullable().default(null),
  preferences: z
    .object({
      door_type: z.string().max(100).optional(),
      coating: z.string().max(100).optional(),
      color: z.string().max(100).optional(),
      style: z.string().max(100).optional(),
    })
    .default({}),
  chosen: z.array(z.object({ id: z.string().max(100), name: z.string().max(300) })).max(30).default([]),
  rejected: z.array(z.object({ id: z.string().max(100), name: z.string().max(300), reason: z.string().max(300).optional() })).max(30).default([]),
  notes: z.array(z.string().max(500)).max(20).default([]),
  last_calculation: z.object({ total_rub: z.number(), complete: z.boolean(), at: z.string() }).nullable().default(null),
});

export type ClientMemory = z.infer<typeof memorySchema>;
export type MemoryPatch = Partial<Omit<ClientMemory, 'preferences'>> & { preferences?: ClientMemory['preferences'] };

export const memorySubject = (contactId: number | null, leadId: number) =>
  contactId ? `contact:${contactId}` : `lead:${leadId}`;

/** Слияние: размеры заменяются целиком, предпочтения дополняются, модели и заметки накапливаются без повторов. */
export function mergeMemory(cur: ClientMemory, patch: MemoryPatch): ClientMemory {
  const uniq = <T extends { id: string }>(a: T[], b: T[] = []) => {
    const map = new Map(a.map((x) => [x.id, x]));
    for (const x of b) map.set(x.id, x);
    return [...map.values()].slice(-30);
  };
  const chosen = uniq(cur.chosen, patch.chosen);
  const rejected = uniq(cur.rejected, patch.rejected);
  return memorySchema.parse({
    openings: patch.openings ?? cur.openings,
    budget_rub: patch.budget_rub !== undefined ? patch.budget_rub : cur.budget_rub,
    preferences: { ...cur.preferences, ...(patch.preferences ?? {}) },
    // Модель не может быть одновременно выбранной и отклонённой.
    chosen: chosen.filter((c) => !(patch.rejected ?? []).some((r) => r.id === c.id)),
    rejected: rejected.filter((r) => !(patch.chosen ?? []).some((c) => c.id === r.id)),
    notes: [...new Set([...cur.notes, ...(patch.notes ?? [])])].slice(-20),
    last_calculation: patch.last_calculation !== undefined ? patch.last_calculation : cur.last_calculation,
  });
}

export class MemoryRepo {
  constructor(private readonly db: Db) {}

  async get(accountId: number, subject: string): Promise<{ data: ClientMemory; summary: string | null; updatedAt: Date | null }> {
    const { rows } = await this.db.query('SELECT data, summary, updated_at FROM client_memory WHERE account_id = $1 AND subject = $2', [
      accountId,
      subject,
    ]);
    const r = rows[0];
    return { data: memorySchema.parse(r?.data ?? {}), summary: r?.summary ?? null, updatedAt: r?.updated_at ?? null };
  }

  async update(accountId: number, subject: string, patch: MemoryPatch): Promise<ClientMemory> {
    const cur = await this.get(accountId, subject);
    const next = mergeMemory(cur.data, patch);
    await this.db.query(
      `INSERT INTO client_memory (account_id, subject, data) VALUES ($1, $2, $3)
       ON CONFLICT (account_id, subject) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [accountId, subject, next],
    );
    return next;
  }

  async setSummary(accountId: number, subject: string, summary: string): Promise<void> {
    await this.db.query(
      `INSERT INTO client_memory (account_id, subject, summary) VALUES ($1, $2, $3)
       ON CONFLICT (account_id, subject) DO UPDATE SET summary = EXCLUDED.summary, updated_at = now()`,
      [accountId, subject, summary.slice(0, 8000)],
    );
  }
}

/** Память текстом для системной инструкции. */
export function memoryToText(m: ClientMemory, summary: string | null): string | null {
  const parts: string[] = [];
  if (summary) parts.push(`Резюме прошлых обращений: ${summary}`);
  if (m.openings.length) {
    parts.push(
      `Проёмы: ${m.openings
        .map((o) => [o.room, o.width_mm && o.height_mm ? `${o.width_mm}×${o.height_mm} мм` : null, o.wall_mm ? `стена ${o.wall_mm} мм` : null, o.qty ? `${o.qty} шт.` : null].filter(Boolean).join(', '))
        .join('; ')}`,
    );
  }
  if (m.budget_rub) parts.push(`Бюджет клиента: ${m.budget_rub} ₽`);
  const pref = Object.entries(m.preferences).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (pref.length) parts.push(`Предпочтения: ${pref.join(', ')}`);
  if (m.chosen.length) parts.push(`Понравились: ${m.chosen.map((c) => `${c.name} (id ${c.id})`).join('; ')}`);
  if (m.rejected.length) parts.push(`Отклонил: ${m.rejected.map((c) => `${c.name}${c.reason ? ` — ${c.reason}` : ''}`).join('; ')}`);
  if (m.notes.length) parts.push(`Заметки: ${m.notes.join('; ')}`);
  return parts.length ? parts.join('\n') : null;
}
