import type { FastifyInstance } from 'fastify';
import { markdownToHtml, PRIVACY_MD, TERMS_MD } from '../legal/texts.ts';

/** Политика конфиденциальности и соглашение — публичные страницы для карточки виджета в Маркетплейсе. */
export function legalRoutes(app: FastifyInstance) {
  const pages: Record<string, { title: string; md: string }> = {
    privacy: { title: 'Политика конфиденциальности — AI-продавец дверей', md: PRIVACY_MD },
    terms: { title: 'Пользовательское соглашение — AI-продавец дверей', md: TERMS_MD },
  };
  for (const [slug, page] of Object.entries(pages)) {
    const html = markdownToHtml(page.md, page.title);
    app.get(`/legal/${slug}`, async (_req, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'public, max-age=3600').send(html));
    app.get(`/legal/${slug}.md`, async (_req, reply) => reply.type('text/markdown; charset=utf-8').send(page.md));
  }
}
