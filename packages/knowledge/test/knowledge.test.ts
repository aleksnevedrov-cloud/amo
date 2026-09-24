import { AccountsRepo, type Db } from '@ai-door/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../db/test/setup.ts';
import { chunkText, htmlToText, KnowledgeRepo } from '../src/index.ts';

describe('chunkText', () => {
  it('склеивает короткие абзацы и режет длинные', () => {
    const parts = chunkText(['a'.repeat(500), 'b'.repeat(500), 'c'.repeat(500)].join('\n\n'), 1200);
    expect(parts).toHaveLength(2);
    const long = chunkText('Предложение. '.repeat(300), 1200);
    expect(long.every((p) => p.length <= 1200)).toBe(true);
    expect(long.join(' ').replace(/\s+/g, ' ').trim()).toBe('Предложение. '.repeat(300).trim());
  });
});

describe('htmlToText', () => {
  it('берёт заголовок и текст статьи без меню и скриптов', () => {
    const html = `<html><head><title>Сайт</title><script>var x=1</script></head><body><nav>Меню</nav>
      <article><h1>Эмаль или экошпон</h1><p>Эмаль&nbsp;— краска.</p><p>Экошпон — плёнка.</p></article></body></html>`;
    const r = htmlToText(html);
    expect(r.title).toBe('Эмаль или экошпон');
    expect(r.text).toContain('Эмаль — краска.');
    expect(r.text).not.toContain('Меню');
    expect(r.text).not.toContain('var x');
  });
});

describe('KnowledgeRepo', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let repo: KnowledgeRepo;

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
    for (const id of [1, 2]) await new AccountsRepo(db).upsertInstalled({ id, subdomain: `a${id}`, accountDomain: `a${id}.amocrm.ru` });
    const html = '<html><body><article><h1>Уход за дверями из массива</h1><p>Массив протирают сухой тканью, раз в год обновляют масло. Избегайте перепадов влажности.</p></article></body></html>';
    repo = new KnowledgeRepo(db, { fetch: (async () => new Response(html)) as typeof fetch, resolve: async () => ['93.158.134.3'] });
    await repo.addFaq(1, 'Сколько стоит доставка по Москве?', 'Доставка по Москве в пределах МКАД — 1500 ₽.');
    await repo.addText(1, 'Экошпон', 'Экошпон — многослойная полипропиленовая плёнка с текстурой дерева. Устойчив к царапинам и влаге.');
    await repo.addUrl(1, 'https://rf-dveri.ru/sovety/massiv');
  });
  afterAll(async () => drop());

  it('находит фрагмент с источником и датой', async () => {
    const hits = await repo.search(1, 'доставка москва');
    expect(hits[0]).toMatchObject({ kind: 'faq', title: 'Сколько стоит доставка по Москве?' });
    expect(hits[0]?.content).toContain('1500 ₽');
    expect(hits[0]?.createdAt).toBeInstanceOf(Date);
    const massiv = await repo.search(1, 'как ухаживать за массивом');
    expect(massiv[0]).toMatchObject({ kind: 'url', source: 'https://rf-dveri.ru/sovety/massiv', title: 'Уход за дверями из массива' });
  });

  it('изолирует аккаунты, список и удаление', async () => {
    expect(await repo.search(2, 'доставка')).toEqual([]);
    const items = await repo.list(1);
    expect(items).toHaveLength(3);
    expect(await repo.remove(2, items[0]!.id)).toBe(false);
    expect(await repo.remove(1, items[0]!.id)).toBe(true);
    expect(await repo.list(1)).toHaveLength(2);
  });

  it('пустой запрос ничего не ищет', async () => {
    expect(await repo.search(1, '?!')).toEqual([]);
  });
});
