import type { FastifyInstance } from 'fastify';

/** Кладёт value по ключу вида data[lead_id] / items[0][url] / tags[] во вложенную структуру. */
function setDeep(target: Record<string, unknown>, key: string, value: string): void {
  const parts = key.replace(/\]/g, '').split('[');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = target;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? '';
    if (i === parts.length - 1) {
      if (p === '') {
        if (Array.isArray(cur)) cur.push(value);
      } else {
        cur[p] = value;
      }
      return;
    }
    const next = parts[i + 1] ?? '';
    if (cur[p] === undefined || typeof cur[p] !== 'object') cur[p] = /^\d*$/.test(next) ? [] : {};
    cur = cur[p];
  }
}

/** application/x-www-form-urlencoded -> объект с вложенностью по PHP-скобкам. */
export function parseFormBody(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(raw)) setDeep(out, k, v);
  return out;
}

/** Salesbot amoCRM (widget_request) шлёт тело формой, а не JSON — без парсера Fastify отвечает 415. */
export function registerFormBody(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, parseFormBody(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
}
