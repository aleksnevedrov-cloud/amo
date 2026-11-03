// Виджет 2.0.7 падал на старых черновиках (12.10: payload без requirements, answers, delivery, letterText, у source нет skipped):
// при выдаче payload дозаполняется — массивы [], объекты {} / null, строки ''. Новые черновики не меняются.
import { describe, expect, it } from 'vitest';
import { normalizeDraftPayload } from '../src/index.ts';

describe('нормализация payload черновика при выдаче', () => {
  it('черновик 12.10 (kp_drafts id 8): все массивы и объекты на месте, source без skipped / documents дозаполнен', () => {
    const old = {
      items: [{ request_index: 0, name: 'Дверь ДПС 01', size: '2100×900', qty: 11, price: null }],
      client: { org: 'ООО Ромашка', email: 'ivanov@romashka.ru' },
      source: { from: 'amo_card', mails: 1, letterAt: '2026-10-09T10:00:00Z', attachments: ['Двери (3).docx'] },
      questions: ['Сторона открывания?'],
      candidates: [],
      components: [],
      generatedAt: '2026-10-12T10:00:00Z',
      needs_manager: [{ request_index: 0, reason: 'цена не задана' }],
      request_items: [{ raw: 'ДПС 01', name: 'Дверь ДПС 01', width_mm: 900, height_mm: 2100, qty: 11 }],
      required_blocks: ['price'],
    };
    const p = normalizeDraftPayload(old);
    expect(p.requirements).toEqual([]);
    expect(p.photos).toEqual([]);
    expect(p.answers).toEqual({});
    expect(p.componentDoorGroups).toEqual({});
    expect(p.delivery).toBeNull();
    expect(p.priceValidity).toBeNull();
    expect(p.letterText).toBeNull();
    expect(p.scope).toBeNull();
    expect(p.projectRest).toEqual([]);
    expect(p.client).toEqual({ org: 'ООО Ромашка', fio: '', email: 'ivanov@romashka.ru', phone: '' });
    expect(p.source).toMatchObject({ from: 'amo_card', mails: 1, attachments: ['Двери (3).docx'], documents: [], skipped: [] });
    expect(p.items[0]).toMatchObject({ request_index: 0, page_id: null, name: 'Дверь ДПС 01', qty: 11, price: null, lead_time: '', discount: 0 });
    expect(p.questions).toEqual(['Сторона открывания?']);
    expect(p.needs_manager).toEqual([{ request_index: 0, reason: 'цена не задана' }]);
  });

  it('совсем пустой или битый payload — пустой черновик без ошибок; новый payload не меняется', () => {
    const empty = normalizeDraftPayload(null);
    expect(empty.items).toEqual([]);
    expect(empty.source).toEqual({ from: 'none', mails: 0, letterAt: null, attachments: [], documents: [], skipped: [] });
    expect(normalizeDraftPayload({ items: 'x', client: 7, source: [], needs_manager: [null, { request_index: 1, reason: 'r' }] })).toMatchObject({ items: [], client: { org: '', fio: '', email: '', phone: '' }, needs_manager: [{ request_index: 1, reason: 'r' }] });
    const fresh = { client: { org: 'A', fio: 'B', email: 'c@d.ru', phone: '1' }, request_items: [], candidates: [], items: [], components: [], required_blocks: [], questions: [], needs_manager: [], answers: { 'delivery:0': { option: 'pickup' } }, delivery: { mode: 'pickup', address: null, sum: null }, priceValidity: '30 календарных дней', source: { from: 'mailbox', mails: 2, letterAt: null, attachments: [], documents: [1], skipped: [{ name: 'a.pdf', reason: 'большой' }], mail: { status: 'found', messageId: '<m@x>', date: null, subject: 'Тема', searchedFrom: 'a@b.ru', from: 'a@b.ru', fromName: null, attachments: 1, taken: ['a.pdf'], uploaded: [], skipped: [], error: null, retryAt: null, folder: 'INBOX', matchedBy: 'address', diag: null } }, generatedAt: '2026-10-23T00:00:00Z', requirements: ['ГОСТ 31173'], photos: [], letterText: 'Текст', scope: null, projectRest: [] };
    expect(normalizeDraftPayload(fresh)).toMatchObject(fresh);
  });
});
