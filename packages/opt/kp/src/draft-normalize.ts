import type { KpPayload } from './draft.ts';

/**
 * Нормализация payload черновика при выдаче (виджет 2.0.7: «не удалось отобразить блок» на черновиках 12.10 — у них нет
 * requirements, answers, delivery, priceValidity, letterText, componentDoorGroups, а у source — skipped / documents).
 * Все массивы — хотя бы [], объекты — хотя бы {} / поля с умолчаниями; строки клиента — ''. Сам черновик в БД не меняется.
 */
export function normalizeDraftPayload(raw: unknown): KpPayload {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const obj = <T extends object>(v: unknown): T | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : null);
  const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
  const client = obj<Record<string, unknown>>(p.client) ?? {};
  const src = obj<Record<string, unknown>>(p.source);
  const source: KpPayload['source'] | null = src
    ? {
        ...(src as unknown as KpPayload['source']),
        from: (['amo_card', 'mailbox', 'none'] as const).includes(src.from as 'amo_card') ? (src.from as KpPayload['source']['from']) : 'none',
        mails: Number(src.mails ?? 0) || 0,
        letterAt: typeof src.letterAt === 'string' ? src.letterAt : null,
        attachments: arr<string>(src.attachments),
        documents: arr<number>(src.documents),
        skipped: arr<{ name: string; reason: string; failed?: boolean }>(src.skipped).filter((x) => x && typeof x === 'object'),
        ...(Array.isArray(src.files) ? { files: src.files as NonNullable<KpPayload['source']['files']> } : {}),
        ...(obj(src.mail) ? { mail: normalizeMail(src.mail as Record<string, unknown>) } : {}),
      }
    : null;
  const items = arr<Record<string, unknown>>(p.items)
    .filter((l) => l && typeof l === 'object')
    .map((l, i) => ({
      ...l,
      request_index: Number(l.request_index ?? i) || 0,
      page_id: (l.page_id as string | null | undefined) ?? null,
      name: str(l.name),
      size: str(l.size),
      qty: Number(l.qty ?? 1) || 0,
      price: typeof l.price === 'number' ? l.price : null,
      lead_time: str(l.lead_time),
      discount: Number(l.discount ?? 0) || 0,
    })) as unknown as KpPayload['items'];
  return {
    ...(p as unknown as KpPayload),
    client: { org: str(client.org), fio: str(client.fio), email: str(client.email), phone: str(client.phone) },
    request_items: arr(p.request_items),
    candidates: [] as never[],
    items,
    components: [] as never[],
    required_blocks: arr<string>(p.required_blocks),
    questions: arr<string>(p.questions),
    needs_manager: arr<{ request_index: number; reason: string }>(p.needs_manager).filter((x) => x && typeof x === 'object'),
    componentDoorGroups: obj<Record<string, number>>(p.componentDoorGroups) ?? {},
    answers: obj<NonNullable<KpPayload['answers']>>(p.answers) ?? {},
    delivery: obj<NonNullable<KpPayload['delivery']>>(p.delivery) ?? null,
    priceValidity: typeof p.priceValidity === 'string' ? p.priceValidity : null,
    // source у старого черновика может отсутствовать: виджет покажет «источник неизвестен», а не упадёт.
    source: source ?? { from: 'none', mails: 0, letterAt: null, attachments: [], documents: [], skipped: [] },
    generatedAt: typeof p.generatedAt === 'string' ? p.generatedAt : '',
    requirements: arr<string>(p.requirements),
    photos: arr(p.photos),
    letterText: typeof p.letterText === 'string' ? p.letterText : null,
    scope: obj<NonNullable<KpPayload['scope']>>(p.scope) ?? null,
    projectRest: arr(p.projectRest),
    projectAdded: arr<string>(p.projectAdded),
  };
}

function normalizeMail(m: Record<string, unknown>): NonNullable<KpPayload['source']['mail']> {
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    ...(m as unknown as NonNullable<KpPayload['source']['mail']>),
    status: (['found', 'not_found', 'error', 'partial', 'skipped'] as const).includes(m.status as 'found') ? (m.status as 'found') : 'skipped',
    messageId: typeof m.messageId === 'string' ? m.messageId : null,
    date: typeof m.date === 'string' ? m.date : null,
    subject: typeof m.subject === 'string' ? m.subject : '',
    searchedFrom: typeof m.searchedFrom === 'string' ? m.searchedFrom : '',
    from: typeof m.from === 'string' ? m.from : null,
    fromName: typeof m.fromName === 'string' ? m.fromName : null,
    ...(Array.isArray(m.files) ? { files: m.files as never } : {}),
    attachments: Number(m.attachments ?? 0) || 0,
    taken: arr<string>(m.taken),
    uploaded: arr<string>(m.uploaded),
    skipped: arr<{ name: string; reason: string }>(m.skipped),
    error: typeof m.error === 'string' ? m.error : null,
    retryAt: typeof m.retryAt === 'string' ? m.retryAt : null,
    folder: typeof m.folder === 'string' ? m.folder : null,
    matchedBy: m.matchedBy === 'address' || m.matchedBy === 'domain' ? m.matchedBy : null,
    diag: (m.diag as never) ?? null,
  };
}
