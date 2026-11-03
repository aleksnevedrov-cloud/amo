/**
 * RFD-AI-AGENT-OPT-DEAL-FILES-2, 2.5: ход сборки черновика для менеджера. Задание draft пишет его в BullMQ
 * (job.updateProgress) на каждом шаге и на каждой странице распознавания; GET /kp/draft отдаёт шаг, файл, страницу,
 * прошедшее время и оценку оставшегося; виджет рисует полосу, строку шага и список файлов со статусами.
 */
export const DRAFT_STEPS = [
  'Читаю карточку сделки',
  'Ищу файлы: сделка, письмо, Яндекс Диск',
  'Скачиваю файлы',
  'Распознаю',
  'Модель читает чертёж',
  'Разбираю позиции',
  'Ищу цены в прайсах',
  'Готово',
] as const;

export type DraftFileState = 'queued' | 'downloading' | 'recognizing' | 'parsing' | 'parsed' | 'repeat' | 'own' | 'failed' | 'skipped';

export interface DraftFileStatus {
  name: string;
  status: DraftFileState;
  positions?: number;
  reason?: string;
}

export interface DraftProgress {
  /** Название шага для менеджера (с именем файла и страницей, если есть). */
  step: string;
  stepNo: number;
  steps: number;
  file: string | null;
  page: number | null;
  pages: number | null;
  /** Файлов обработано / всего (шаги 3–6). */
  done: number;
  total: number;
  startedAt: string;
  updatedAt: string;
  note: string | null;
  files: DraftFileStatus[];
  /** Для оценки оставшегося: распознано страниц и суммарное время на них, разобрано файлов и время на них. */
  pagesDone: number;
  pageMs: number;
  filesDone: number;
  fileMs: number;
  /** Когда начался каждый шаг — длительности шагов в журнал. */
  stepLog: { stepNo: number; step: string; at: string }[];
  /** API уже записал kp_error о зависании (не дублировать при каждом опросе). */
  stuckReportedAt?: string | null;
}

/** Задание дольше этого без нового шага / страницы — «Сборка зависла». */
export const STUCK_AFTER_MS = 10 * 60_000;

export class ProgressReporter {
  readonly state: DraftProgress;
  private pageStartedAt: number | null = null;
  private fileStartedAt: number | null = null;

  constructor(
    private readonly emit: (p: DraftProgress) => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    const at = new Date(this.now()).toISOString();
    this.state = { step: DRAFT_STEPS[0], stepNo: 1, steps: DRAFT_STEPS.length, file: null, page: null, pages: null, done: 0, total: 0, startedAt: at, updatedAt: at, note: null, files: [], pagesDone: 0, pageMs: 0, filesDone: 0, fileMs: 0, stepLog: [] };
  }

  /** Новый шаг (1–8); file — имя файла в названии шага («Распознаю «…», стр. K из P»). */
  step(no: number, extra: { file?: string | null; page?: number | null; pages?: number | null; note?: string | null } = {}): void {
    const base = DRAFT_STEPS[no - 1] ?? `Шаг ${no}`;
    const s = this.state;
    if (s.stepNo !== no || !s.stepLog.length) s.stepLog.push({ stepNo: no, step: base, at: new Date(this.now()).toISOString() });
    s.stepNo = no;
    s.file = extra.file ?? (no >= 3 && no <= 6 ? s.file : null);
    s.page = extra.page ?? null;
    s.pages = extra.pages ?? null;
    s.note = extra.note ?? null;
    s.step = labelOf(no, s.file, s.page, s.pages, s.done, s.total);
    this.touch();
  }

  /** Список файлов к обработке (шаг 3): все «в очереди». */
  files(names: string[]): void {
    this.state.files = names.map((name) => ({ name, status: 'queued' }));
    this.state.total = names.length;
    this.state.done = 0;
    this.touch();
  }

  /** Статус файла; parsed — с числом позиций, failed / skipped / repeat / own — с причиной. */
  file(name: string, status: DraftFileState, extra: { positions?: number; reason?: string } = {}): void {
    const s = this.state;
    const row = s.files.find((f) => f.name === name && f.status !== 'parsed' && f.status !== 'repeat' && f.status !== 'own' && f.status !== 'failed' && f.status !== 'skipped') ?? s.files.find((f) => f.name === name);
    if (row) Object.assign(row, { status, ...extra });
    else s.files.push({ name, status, ...extra });
    const now = this.now();
    if (status === 'downloading') {
      this.fileStartedAt = now;
      this.step(3, { file: name });
    } else if (status === 'parsing') {
      this.step(6, { file: name });
    } else if (status === 'parsed' || status === 'failed' || status === 'repeat' || status === 'own' || status === 'skipped') {
      if (status === 'parsed' && this.fileStartedAt !== null) {
        s.filesDone++;
        s.fileMs += now - this.fileStartedAt;
      }
      this.fileStartedAt = null;
      s.done = s.files.filter((f) => f.status === 'parsed' || f.status === 'failed' || f.status === 'repeat' || f.status === 'own' || f.status === 'skipped').length;
      s.step = labelOf(s.stepNo, s.file, s.page, s.pages, s.done, s.total);
      this.touch();
    } else this.touch();
  }

  /** Страница распознавания (шаг 4) или чтения чертежа моделью (шаг 5). */
  page(file: string | null, page: number, pages: number, byModel: boolean): void {
    const now = this.now();
    if (this.pageStartedAt !== null) {
      this.state.pagesDone++;
      this.state.pageMs += now - this.pageStartedAt;
    }
    this.pageStartedAt = now;
    this.step(byModel ? 5 : 4, { file: file ?? this.state.file, page, pages });
  }

  done(): void {
    this.pageStartedAt = null;
    this.step(8);
  }

  private touch(): void {
    this.state.updatedAt = new Date(this.now()).toISOString();
    this.emit(this.state);
  }
}

function labelOf(no: number, file: string | null, page: number | null, pages: number | null, done: number, total: number): string {
  const base = DRAFT_STEPS[no - 1] ?? `Шаг ${no}`;
  if (no === 3) return `${base} (${Math.min(done + 1, Math.max(total, 1))} из ${Math.max(total, 1)})`;
  if (no === 4 || no === 5) return `${base} «${file ?? ''}»${page ? `, стр. ${page} из ${pages ?? '?'}` : ''}`;
  if (no === 6) return `${base} «${file ?? ''}»`;
  return base;
}

/** Длительности шагов для журнала: «1 Читаю карточку сделки 0,4 с; …». */
export function stepDurations(p: DraftProgress, finishedAt = Date.parse(p.updatedAt)): { stepNo: number; step: string; ms: number }[] {
  // Один шаг может повторяться (скачиваю → распознаю → разбираю по каждому файлу): время суммируется по номеру шага.
  const sum = new Map<number, { step: string; ms: number }>();
  for (const [i, s] of p.stepLog.entries()) {
    const next = p.stepLog[i + 1];
    const end = next ? Date.parse(next.at) : finishedAt;
    const cur = sum.get(s.stepNo) ?? { step: s.step, ms: 0 };
    cur.ms += Math.max(0, end - Date.parse(s.at));
    sum.set(s.stepNo, cur);
  }
  return [...sum.entries()].sort((a, b) => a[0] - b[0]).map(([stepNo, v]) => ({ stepNo, step: v.step, ms: v.ms }));
}

/** Что отдаёт GET /kp/draft по идущему заданию: шаг, файл, страница, прошло, осталось (≈ минуты), зависание. */
export interface DraftProgressView {
  step: string;
  stepNo: number;
  steps: number;
  file: string | null;
  page: number | null;
  pages: number | null;
  done: number;
  total: number;
  files: DraftFileStatus[];
  startedAt: string;
  updatedAt: string;
  elapsedSec: number;
  /** Оценка оставшегося в минутах (не точнее минуты); null — до первой страницы («около 1–5 минут»). */
  etaMin: number | null;
  /** Доля выполненного 0–1 для полосы: пройденные шаги и страницы. */
  fraction: number;
  stuck: boolean;
  /** Запись о зависании уже сделана (API). */
  stuckReportedAt?: string | null;
}

export function progressView(p: DraftProgress, now = Date.now()): DraftProgressView {
  const elapsedSec = Math.max(0, Math.round((now - Date.parse(p.startedAt)) / 1000));
  const avgPage = p.pagesDone ? p.pageMs / p.pagesDone : null;
  const avgFile = p.filesDone ? p.fileMs / p.filesDone : null;
  let etaMin: number | null = null;
  if (p.stepNo >= 8) etaMin = 0;
  else if (avgPage !== null || avgFile !== null) {
    const pagesLeft = p.page !== null && p.pages !== null ? Math.max(0, p.pages - p.page) : 0;
    const filesLeft = Math.max(0, p.total - p.done - (p.file ? 1 : 0));
    const ms = pagesLeft * (avgPage ?? 0) + filesLeft * (avgFile ?? avgPage ?? 0) + (p.file && avgFile ? avgFile / 2 : 0);
    etaMin = Math.max(1, Math.ceil(ms / 60_000));
  }
  const within = p.page !== null && p.pages ? p.page / p.pages : p.total ? p.done / p.total : 0;
  const fraction = Math.min(1, Math.max(0, (p.stepNo - 1 + Math.min(1, within)) / p.steps));
  return { step: p.step, stepNo: p.stepNo, steps: p.steps, file: p.file, page: p.page, pages: p.pages, done: p.done, total: p.total, files: p.files, startedAt: p.startedAt, updatedAt: p.updatedAt, elapsedSec, etaMin, fraction, stuck: p.stepNo < 8 && now - Date.parse(p.updatedAt) > STUCK_AFTER_MS, stuckReportedAt: p.stuckReportedAt ?? null };
}
