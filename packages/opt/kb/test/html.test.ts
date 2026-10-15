import { describe, expect, it } from 'vitest';
import { createUrlFetcher } from '../src/fetch-url.ts';
import { htmlToKbText, sectionLinks } from '../src/html.ts';
import { assertPublicUrl, isPrivateIp, parsePublicUrl } from '../src/safe-url.ts';

const PAGE = `<!doctype html><html><head><title>Цены на двери | РФ-Двери</title><style>.x{}</style></head>
<body>
<header class="site-header"><a href="/">Главная</a><ul class="menu"><li><a href="/catalog/">Каталог</a></li><li><a href="/ceny/">Цены</a></li></ul></header>
<nav aria-label="breadcrumbs">Главная &gt; Цены</nav>
<main>
  <h1>Цены на межкомнатные двери</h1>
  <p>Цены указаны за&nbsp;полотно без учёта доставки.</p>
  <h2>Ламинированные</h2>
  <table><tr><th>Модель</th><th>Размер</th><th>Цена</th></tr>
  <tr><td>ДПГ сота</td><td>800×2000</td><td>3 450 ₽</td></tr>
  <tr><td>ДПО сота</td><td>800×2000</td><td>4 100 ₽</td></tr></table>
  <ul><li>Доплата за нестандарт по высоте — 15 %</li><li>Двупольные — +20 %</li></ul>
  <div class="callback-form"><form><input name="phone"><button>Заказать звонок</button></form></div>
  <a href="/ceny/laminirovannye/">Подробнее о ламинированных</a>
  <a href="/ceny/ekoshpon/?utm=1#top">Экошпон</a>
  <a href="/ceny/?p=2">Страница 2</a>
  <a href="/catalog/dver-1/">Товар из каталога</a>
  <a href="https://other.ru/ceny/x/">Чужой сайт</a>
  <a href="/ceny/prais.pdf">Прайс PDF</a>
  <a href="/ceny/img/logo.png">Картинка</a>
</main>
<footer>© 2026 РФ-Двери · <a href="/contacts/">Контакты</a></footer>
<script>alert(1)</script>
</body></html>`;

describe('текст страницы без меню и подвала', () => {
  it('берётся <main>, заголовки → «# …», таблица → строки с табуляцией, меню/подвал/формы/скрипты вырезаны', () => {
    const { title, text } = htmlToKbText(PAGE);
    expect(title).toBe('Цены на межкомнатные двери');
    expect(text).toContain('# Цены на межкомнатные двери');
    expect(text).toContain('Цены указаны за полотно без учёта доставки.');
    expect(text).toContain('## Ламинированные');
    expect(text).toContain('ДПГ сота\t800×2000\t3 450 ₽');
    expect(text).toContain('- Доплата за нестандарт по высоте — 15 %');
    for (const junk of ['Каталог', 'Главная', '© 2026', 'Контакты', 'Заказать звонок', 'alert(1)', '.x{}']) expect(text).not.toContain(junk);
  });

  it('без <main>: body, блоки с классами меню/подвала/cookie вырезаются, title из <title>', () => {
    const { title, text } = htmlToKbText('<html><head><title>О компании</title></head><body><div class="top-menu">Меню</div><div id="content"><p>Мы делаем двери с 2005 года.</p></div><div class="cookie-notice">Мы используем cookie</div></body></html>');
    expect(title).toBe('О компании');
    expect(text).toBe('Мы делаем двери с 2005 года.');
  });

  it('ссылки раздела: тот же сайт, путь внутри раздела, без utm и якорей, пагинация остаётся, картинки отбрасываются, pdf остаётся', () => {
    expect(sectionLinks(PAGE, 'https://rf-dveri.ru/ceny/')).toEqual([
      'https://rf-dveri.ru/ceny/laminirovannye/',
      'https://rf-dveri.ru/ceny/ekoshpon/',
      'https://rf-dveri.ru/ceny/?p=2',
      'https://rf-dveri.ru/ceny/prais.pdf',
    ]);
    expect(sectionLinks(PAGE, 'https://rf-dveri.ru/ceny/', 2)).toHaveLength(2);
    // Страница-файл в разделе: разделом считается её папка.
    expect(sectionLinks('<a href="/docs/a.html">a</a><a href="/docs/sub/b.html">b</a><a href="/other/">o</a>', 'https://x.ru/docs/index.html')).toEqual(['https://x.ru/docs/a.html', 'https://x.ru/docs/sub/b.html']);
  });
});

describe('безопасные адреса и скачивание', () => {
  it('внутренние адреса, логин в адресе, не-http отклоняются', async () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('93.184.216.34')).toBe(false);
    await expect(assertPublicUrl('ftp://rf-dveri.ru/')).rejects.toThrow('Разрешены только http и https');
    await expect(assertPublicUrl('https://user:pw@rf-dveri.ru/')).rejects.toThrow('логин и пароль');
    await expect(assertPublicUrl('http://127.0.0.1:3001/health')).rejects.toThrow('внутреннюю сеть');
    await expect(assertPublicUrl('https://metadata.internal/', async () => ['169.254.169.254'])).rejects.toThrow('внутреннюю сеть');
    await expect(assertPublicUrl('нет адреса')).rejects.toThrow('Некорректный адрес');
    expect(() => parsePublicUrl('http://localhost:3000/')).toThrow('внутреннюю сеть');
    expect(parsePublicUrl('https://rf-dveri.ru/ceny/').hostname).toBe('rf-dveri.ru');
    expect((await assertPublicUrl('https://rf-dveri.ru/ceny/', async () => ['93.184.216.34'])).toString()).toBe('https://rf-dveri.ru/ceny/');
  });

  it('скачивание: редиректы проверяются по очереди, ошибки HTTP и размер — текстом', async () => {
    const seen: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      expect(init?.redirect).toBe('manual');
      if (url === 'https://a.ru/old') return new Response(null, { status: 301, headers: { location: '/new' } });
      if (url === 'https://a.ru/new') return new Response('<html><body>ok</body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (url === 'https://a.ru/private') return new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/' } });
      if (url === 'https://a.ru/big') return new Response('x'.repeat(100), { status: 200, headers: { 'content-length': '100' } });
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    const fetchUrl = createUrlFetcher({ fetch: f, resolve: async () => ['93.184.216.34'], maxBytes: 50 });
    const got = await fetchUrl('https://a.ru/old');
    expect(got).toMatchObject({ mime: 'text/html', finalUrl: 'https://a.ru/new', status: 200 });
    expect(new TextDecoder().decode(got.bytes)).toContain('ok');
    expect(seen).toEqual(['https://a.ru/old', 'https://a.ru/new']);
    await expect(fetchUrl('https://a.ru/private')).rejects.toThrow('внутреннюю сеть');
    await expect(fetchUrl('https://a.ru/missing')).rejects.toThrow('HTTP 404');
    await expect(fetchUrl('https://a.ru/big')).rejects.toThrow('ответ больше 0 МБ');
  });
});
