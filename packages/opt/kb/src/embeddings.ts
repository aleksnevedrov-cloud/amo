import OpenAI from 'openai';

/**
 * Эмбеддинги фрагментов и запросов: OpenAI text-embedding-3-small (1536) тем же SDK и тем же ключом,
 * что чат-модель опта (ключ аккаунта из настроек «Модель», иначе серверный OPENAI_API_KEY).
 * Стоимость считается здесь и пишется в журнал вызывающим (kb_index, kb_search).
 */
export const EMBEDDING_DIMS = 1536;
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
/** $ за 1M токенов (openai.com/api/pricing, сверять при смене прайса). */
export const EMBEDDING_PRICE_USD_PER_1M: Record<string, number> = {
  'text-embedding-3-small': 0.02,
  'text-embedding-3-large': 0.13,
  'text-embedding-ada-002': 0.1,
};
/** Текстов в одном запросе к API. */
export const EMBEDDING_BATCH = 64;

export interface EmbedResult {
  vectors: number[][];
  tokens: number;
  usd: number;
  model: string;
}

export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<EmbedResult>;
}

export type EmbedderFor = (accountId: number) => Promise<Embedder | null>;

export interface OpenAiEmbedderOptions {
  model?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  baseURL?: string;
}

export function embeddingCostUsd(model: string, tokens: number): number {
  const perM = EMBEDDING_PRICE_USD_PER_1M[model] ?? EMBEDDING_PRICE_USD_PER_1M[DEFAULT_EMBEDDING_MODEL] ?? 0;
  return (tokens / 1_000_000) * perM;
}

export class OpenAiEmbedder implements Embedder {
  readonly model: string;
  private readonly client: OpenAI;

  constructor(apiKey: string, opts: OpenAiEmbedderOptions = {}) {
    this.model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
    this.client = new OpenAI({
      apiKey,
      timeout: opts.timeoutMs ?? 60_000,
      maxRetries: opts.maxRetries ?? 2,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const vectors: number[][] = [];
    let tokens = 0;
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH) {
      const batch = texts.slice(i, i + EMBEDDING_BATCH).map((t) => t.replace(/\s+/g, ' ').trim() || ' ');
      const res = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        // Размерность фиксирована схемой kb_chunks (vector(1536)); модели text-embedding-3-* её принимают.
        ...(this.model.startsWith('text-embedding-3') ? { dimensions: EMBEDDING_DIMS } : {}),
      });
      const sorted = [...res.data].sort((a, b) => a.index - b.index);
      for (const d of sorted) vectors.push(d.embedding);
      tokens += res.usage?.prompt_tokens ?? 0;
    }
    return { vectors, tokens, usd: embeddingCostUsd(this.model, tokens), model: this.model };
  }
}

/** Вектор → литерал pgvector «[0.1,0.2,…]». */
export function toVectorLiteral(v: number[]): string {
  if (v.length !== EMBEDDING_DIMS) throw new Error(`Размерность эмбеддинга ${v.length}, ожидается ${EMBEDDING_DIMS}`);
  return `[${v.map((x) => (Number.isFinite(x) ? x.toString() : '0')).join(',')}]`;
}
