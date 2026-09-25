// Приёмка фазы 3: разбор реальных файлов заказчика.
// Файлы — в evals/documents/files/ (не в репозитории), ожидания — в expected.json по началу имени файла.
// Без ANTHROPIC_API_KEY проверяется извлечение текста, чистка ПДн и маркировки; с ключом — ещё и структура от модели.
// Для сканов и фото нужен ключ Yandex Vision (YANDEX_VISION_API_KEY или YANDEX_SPEECHKIT_API_KEY + YANDEX_FOLDER_ID).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AnthropicLlm } from '@ai-door/agent';
import { defaultSettings, type DocumentsRepo, type NewDocument } from '@ai-door/db';
import { cleanPersonalData, DocumentService, extract, findMarkings, YandexVision } from '@ai-door/docs';
import { z } from 'zod';
import { seeded } from '../../packages/tools/test/fixtures.ts';

const expectedSchema = z.object({
  id: z.string(),
  what: z.string(),
  format: z.string(),
  needsOcr: z.boolean(),
  pages: z.number().optional(),
  contains: z.array(z.string()).default([]),
  notContains: z.array(z.string()).default([]),
  minMarkings: z.number().default(0),
  minPiiRemoved: z.number().default(0),
  kind: z.string(),
  customerType: z.string().optional(),
  minOpenings: z.number().default(0),
  minPositions: z.number().default(0),
  requiresOcr: z.boolean().default(false),
});

const dir = process.env.DOC_FILES_DIR ?? new URL('files/', import.meta.url).pathname;
const expected = (JSON.parse(readFileSync(new URL('expected.json', import.meta.url), 'utf8')).files as unknown[]).map((x) => expectedSchema.parse(x));
const files = readdirSync(dir).filter((f) => !f.startsWith('.'));
const key = process.env.ANTHROPIC_API_KEY;
const visionKey = process.env.YANDEX_VISION_API_KEY ?? process.env.YANDEX_SPEECHKIT_API_KEY;
const folder = process.env.YANDEX_FOLDER_ID;

interface Row {
  id: string;
  what: string;
  extraction: string[];
  llm: string[];
  skipped?: string;
}
const rows: Row[] = [];
const s = key ? await seeded(1) : null;
const saved: NewDocument[] = [];
const svc =
  key && s
    ? new DocumentService({
        llm: new AnthropicLlm(key),
        catalog: s.catalog,
        documents: { add: async (d: NewDocument) => (saved.push(d), saved.length), countToday: async () => 0 } as unknown as DocumentsRepo,
        ocr: () => (visionKey && folder ? new YandexVision(visionKey, folder) : null),
      })
    : null;
const settings = defaultSettings();

try {
  for (const e of expected) {
    const file = files.find((f) => f.startsWith(e.id));
    const row: Row = { id: e.id, what: e.what, extraction: [], llm: [] };
    rows.push(row);
    if (!file) {
      row.skipped = 'файла нет в каталоге';
      continue;
    }
    const bytes = new Uint8Array(readFileSync(`${dir}/${file}`));
    const ex = await extract(bytes, '', file);
    const cleaned = cleanPersonalData(ex.text);
    const check = (ok: boolean, msg: string) => row.extraction.push(`${ok ? '✓' : '✗'} ${msg}`);
    check(ex.format === e.format, `формат ${ex.format}`);
    check(ex.needsOcr === e.needsOcr, `OCR ${ex.needsOcr ? 'нужен' : 'не нужен'}`);
    if (e.pages) check(ex.pages === e.pages, `страниц ${ex.pages}`);
    for (const c of e.contains) check(cleaned.text.includes(c), `есть «${c}»`);
    for (const c of e.notContains) check(!cleaned.text.includes(c), `нет «${c}» (ПДн)`);
    if (e.minPiiRemoved) check(cleaned.removed >= e.minPiiRemoved, `ПДн скрыто: ${cleaned.removed}`);
    if (e.minMarkings) {
      const n = findMarkings(cleaned.text).length;
      check(n >= e.minMarkings, `маркировок ${n} (≥ ${e.minMarkings})`);
    }
    if (!svc) {
      row.llm.push('– без ANTHROPIC_API_KEY структура не проверялась');
      continue;
    }
    if (e.requiresOcr && !(visionKey && folder)) {
      row.llm.push('– нужен ключ Yandex Vision');
      continue;
    }
    try {
      const r = await svc.analyze({ accountId: 1, leadId: null, source: 'sandbox', filename: file, mime: '', bytes, settings });
      const ok = (cond: boolean, msg: string) => row.llm.push(`${cond ? '✓' : '✗'} ${msg}`);
      ok(r.kind === e.kind, `тип ${r.kind} (ожидался ${e.kind})`);
      if (e.customerType) ok(r.data.customer_type === e.customerType, `клиент ${r.data.customer_type}`);
      if (e.minOpenings) ok(r.data.openings.length >= e.minOpenings, `проёмов ${r.data.openings.length} (≥ ${e.minOpenings})`);
      if (e.minPositions) ok(r.data.positions.length >= e.minPositions, `позиций ${r.data.positions.length} (≥ ${e.minPositions})`);
      row.llm.push(`  $${r.costUsd.toFixed(3)} · ${r.data.summary}`);
    } catch (err) {
      row.llm.push(`✗ ошибка: ${(err as Error).message}`);
    }
  }
} finally {
  await s?.drop();
}

const lines = rows.map((r) => `## ${r.id} — ${r.what}\n${r.skipped ? `– ${r.skipped}` : [...r.extraction, ...r.llm].join('\n')}`);
const failed = rows.filter((r) => [...r.extraction, ...r.llm].some((x) => x.startsWith('✗')));
const report = `# Приёмка фазы 3: файлы заказчика\n\nФайлов: ${rows.filter((r) => !r.skipped).length} из ${rows.length}; с ошибками: ${failed.length}.\n\n${lines.join('\n\n')}\n`;
console.log(report);
mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../results/documents-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`, import.meta.url), report);
process.exit(failed.length ? 1 : 0);
