import type { JournalRepo } from '@core/db';
import { withMarkup, type KbPricesRepo, type KbRepo } from '@opt/kb';
import type { KpLine, KpPayload } from './draft.ts';
import type { KpRepo } from './repo.ts';
import { KP_PRICE_RESEARCH_KIND } from './research-job.ts';

/**
 * KB-MARKUP: новая наценка источника к ценам из прайса уже созданного черновика. Сам черновик при смене наценки не
 * пересчитывается. Берутся только строки с ценой прайса, которую менеджер не менял (priceSource price_file / kb, цена = итог
 * наценки); цена фабрики — из строки (до KB-MARKUP наценки не было — цена строки и есть цена фабрики). Цены интернета и ручные
 * не трогаются. Нестандарт: у строки цена фабрики уже с надбавкой (factoryPrice), наценка — поверх неё.
 *
 * RFD-AI-AGENT-OPT-AUTO-MARKUP: кнопки «Пересчитать» в окне КП больше нет — тот же пересчёт делает сборка документа
 * (buildDraftDocument, trigger 'build') до проверок цен и рендера; маршрут POST /kp/draft/:id/recalc-markup оставлен.
 */
export interface MarkupRecalcResult {
  changed: { requestIndex: number; name: string; before: number; after: number; pct: number }[];
  /** Строки прайса, для которых источник не найден (файл удалён, ключа нет) — цена оставлена, нажмите «Найти цены». */
  skipped: number[];
}

/** Что нужно пересчёту: черновики, цены и наценки базы знаний, журнал (OptCore подходит целиком). */
export interface MarkupDeps {
  kp: Pick<KpRepo, 'byId' | 'setPayloadIfVersion'>;
  kb: { prices: Pick<KbPricesRepo, 'byId'>; repo: Pick<KbRepo, 'markupOf'> };
  journal: Pick<JournalRepo, 'add'>;
}

export interface MarkupRecalcOptions {
  /** button — маршрут recalc-markup (как раньше); build — сборка документа: другая запись в журнале. */
  trigger?: 'button' | 'build';
  /** Номер КП для записи «при сборке КП N» (у черновика без номера — «по черновику N»). */
  kpNo?: string | null;
}

export async function recalcDraftMarkup(core: MarkupDeps, accountId: number, draftId: number, userId: number | null, opts: MarkupRecalcOptions = {}): Promise<MarkupRecalcResult> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const draft = await core.kp.byId(accountId, draftId);
    if (!draft) throw new Error(`черновик ${draftId} не найден`);
    const payload = draft.payload as unknown as Partial<KpPayload>;
    const items = [...(payload.items ?? [])];
    const changed: MarkupRecalcResult['changed'] = [];
    const skipped: number[] = [];
    const cache = new Map<string, number | null>();
    for (const [i, line] of items.entries()) {
      if (!fromPriceFile(line)) continue;
      const kb = line.kbPriceId ? await core.kb.prices.byId(accountId, line.kbPriceId) : null;
      const sourceId = kb?.sourceId ?? line.markup?.sourceId ?? null;
      const priceKey = kb?.priceKey ?? line.markup?.priceKey ?? null;
      const key = `${sourceId ?? ''}|${priceKey ?? ''}`;
      if (!cache.has(key)) cache.set(key, kb ? kb.markupPct : await core.kb.repo.markupOf(accountId, sourceId, priceKey));
      const pct = cache.get(key) ?? null;
      if (pct === null) {
        skipped.push(line.request_index);
        continue;
      }
      const factory = line.markup?.factoryPrice ?? (line.price as number);
      const price = withMarkup(factory, pct);
      const markup = pct ? { factoryPrice: factory, pct, price, sourceId, priceKey } : null;
      if (price === line.price && (line.markup?.pct ?? 0) === pct) continue;
      changed.push({ requestIndex: line.request_index, name: line.name, before: line.price as number, after: price, pct });
      items[i] = { ...line, price, markup } as KpLine;
    }
    if (!changed.length) return { changed, skipped };
    if (!(await core.kp.setPayloadIfVersion(draftId, draft.version, { ...payload, items } as unknown as Record<string, unknown>))) continue;
    const list = changed.slice(0, 10).map((c) => `«${c.name}» ${c.before.toLocaleString('ru-RU')} → ${c.after.toLocaleString('ru-RU')} ₽`).join('; ');
    const where = opts.trigger === 'build' ? `при сборке КП ${opts.kpNo ?? `по черновику ${draftId}`}` : `по черновику ${draftId}`;
    await core.journal.add({
      accountId,
      leadId: draft.leadId,
      kind: KP_PRICE_RESEARCH_KIND,
      summary: `Пересчёт наценки ${where}: изменено позиций ${changed.length}${list ? ` — ${list}${changed.length > 10 ? ` и ещё ${changed.length - 10}` : ''}` : ''}`,
      details: { draftId, source: 'kb_markup', trigger: opts.trigger ?? 'button', changed, skipped, userId },
    });
    return { changed, skipped };
  }
  throw new Error(`черновик ${draftId} меняется параллельно — наценка не пересчитана`);
}

/** Цена из прайса, которую менеджер не трогал: источник прайс, цена есть и равна итогу наценки (если она уже была). */
function fromPriceFile(line: KpLine): boolean {
  if (line.price === null || line.price <= 0 || line.excluded) return false;
  if (line.priceSource !== 'price_file' && line.priceSource !== 'kb') return false;
  if (line.priceOutcome && line.priceOutcome !== 'priced' && line.priceOutcome !== 'estimate') return false;
  return !line.markup || line.markup.price === line.price;
}
