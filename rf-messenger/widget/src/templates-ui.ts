/**
 * Управление шаблонами: окно со списком и формой. Личные — у каждого менеджера (⋮ → «Мои шаблоны»),
 * общие — у администратора в настройках виджета.
 */
import type { ChatApi, UploadedFile } from './chat.ts';
import { esc } from './chat.ts';
import { groupByFolder, VARIABLES, type TemplateView } from './templates.ts';

const CSS = `
.rfm-tm{position:fixed;inset:0;background:rgba(32,42,54,.45);z-index:10002;display:flex;align-items:center;justify-content:center;font:13px/1.45 'Open Sans','PT Sans',Arial,sans-serif;color:#2e3640}
.rfm-tm *{box-sizing:border-box}
.rfm-tm-box{background:#fff;border-radius:10px;width:min(820px,calc(100vw - 32px));height:min(640px,calc(100vh - 32px));display:flex;overflow:hidden}
.rfm-tm-list{width:300px;border-right:1px solid #e1e5e9;display:flex;flex-direction:column}
.rfm-tm-list-head{padding:10px 12px;border-bottom:1px solid #e1e5e9;display:flex;align-items:center;gap:8px;font-weight:600}
.rfm-tm-items{flex:1;overflow:auto}
.rfm-tm-folder{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#8a96a3;padding:10px 12px 2px}
.rfm-tm-item{display:block;width:100%;border:0;background:transparent;text-align:left;padding:8px 12px;font:inherit;color:inherit;cursor:pointer}
.rfm-tm-item:hover,.rfm-tm-item-on{background:#f2f7ff}
.rfm-tm-item b{display:block;font-weight:600}
.rfm-tm-item small{color:#6b7785;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rfm-tm-form{flex:1;padding:16px 18px;display:flex;flex-direction:column;gap:10px;overflow:auto}
.rfm-tm-form input,.rfm-tm-form textarea{width:100%;border:1px solid #cfd7df;border-radius:6px;padding:7px 10px;font:inherit}
.rfm-tm-form textarea{min-height:160px;resize:vertical}
.rfm-tm-lbl{font-size:12px;color:#6b7785;margin-bottom:3px}
.rfm-tm-vars{display:flex;flex-wrap:wrap;gap:6px}
.rfm-tm-vars button{border:1px solid #cfd7df;background:#fff;border-radius:999px;padding:2px 10px;font:inherit;font-size:12px;cursor:pointer}
.rfm-tm-actions{display:flex;gap:8px;justify-content:space-between;margin-top:auto}
.rfm-tm-btn{height:32px;padding:0 12px;border:1px solid #cfd7df;border-radius:6px;background:#fff;font:inherit;cursor:pointer}
.rfm-tm-btn-primary{background:#4c8bf5;border-color:#4c8bf5;color:#fff}
.rfm-tm-btn-danger{color:#a12b2b}
.rfm-tm-att{display:flex;flex-wrap:wrap;gap:6px}
.rfm-tm-att span{background:#eef2f6;border-radius:6px;padding:3px 8px;font-size:12px;display:flex;gap:6px;align-items:center}
.rfm-tm-att button{border:0;background:transparent;cursor:pointer;color:#8a96a3}
.rfm-tm-err{background:#fdecec;color:#a12b2b;border-radius:6px;padding:6px 10px;font-size:12px}
.rfm-tm-empty{padding:16px;color:#8a96a3;text-align:center}
`;

export function templateListHtml(list: readonly TemplateView[], currentId: number | null): string {
  if (!list.length) return '<div class="rfm-tm-empty">Шаблонов пока нет</div>';
  return groupByFolder(list)
    .map((g) => `<div class="rfm-tm-folder">${esc(g.folder)}</div>${g.items.map((t) => `<button type="button" class="rfm-tm-item${t.id === currentId ? ' rfm-tm-item-on' : ''}" data-tm="pick" data-id="${t.id}"><b>${esc(t.title)}${t.shared ? ' <small style="display:inline;color:#2f6fd6">· общий</small>' : ''}</b><small>${esc(t.text).slice(0, 80)}</small></button>`).join('')}`)
    .join('');
}

export function templateFormHtml(t: Partial<TemplateView> | null, opts: { shared: boolean; canEdit: boolean; error?: string }): string {
  const att = (t?.attachments ?? []).map((a, i) => `<span>📎 ${esc(a.name)}<button type="button" data-tm="unatt" data-i="${i}" title="Убрать">×</button></span>`).join('');
  return `<div class="rfm-tm-form">
<div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:15px">${t?.id ? 'Шаблон' : 'Новый шаблон'} ${opts.shared ? '(общий)' : '(личный)'}</b><button type="button" class="rfm-tm-btn" data-tm="close">Закрыть</button></div>
${opts.error ? `<div class="rfm-tm-err">${esc(opts.error)}</div>` : ''}
<div><div class="rfm-tm-lbl">Название</div><input name="title" maxlength="120" value="${esc(t?.title ?? '')}"${opts.canEdit ? '' : ' readonly'}></div>
<div><div class="rfm-tm-lbl">Папка («Замер», «Оплата», «Доставка»…)</div><input name="folder" maxlength="60" value="${esc(t?.folder ?? '')}" list="rfm-tm-folders"${opts.canEdit ? '' : ' readonly'}></div>
<div><div class="rfm-tm-lbl">Текст</div><textarea name="text" maxlength="4000"${opts.canEdit ? '' : ' readonly'}>${esc(t?.text ?? '')}</textarea></div>
<div><div class="rfm-tm-lbl">Переменные — подставятся при вставке</div><div class="rfm-tm-vars">${VARIABLES.map((v) => `<button type="button" data-tm="var" data-v="${esc(v.name)}" title="${esc(v.hint)}">${esc(v.name)}</button>`).join('')}</div></div>
<div><div class="rfm-tm-lbl">Вложения (фото, PDF)</div><div class="rfm-tm-att" data-tm-att>${att}</div>${opts.canEdit ? '<button type="button" class="rfm-tm-btn" data-tm="att" style="margin-top:6px">Добавить файл</button><input type="file" data-tm-file accept="image/*,application/pdf" style="display:none">' : ''}</div>
${opts.canEdit ? `<div class="rfm-tm-actions">${t?.id ? '<button type="button" class="rfm-tm-btn rfm-tm-btn-danger" data-tm="delete">Удалить</button>' : '<span></span>'}<button type="button" class="rfm-tm-btn rfm-tm-btn-primary" data-tm="save">Сохранить</button></div>` : '<div class="rfm-tm-empty">Общие шаблоны правит администратор в настройках виджета</div>'}
</div>`;
}

/** Окно шаблонов. shared — режим общих шаблонов (настройки виджета, администратор). */
export async function openTemplatesManager(chat: ChatApi, opts: { shared: boolean; isAdmin: boolean }, doc: Document = document, w: Window = window): Promise<() => void> {
  doc.querySelector('.rfm-tm')?.remove();
  const root = doc.createElement('div');
  root.className = 'rfm-tm';
  doc.body.appendChild(root);
  let list: TemplateView[] = [];
  let current: Partial<TemplateView> | null = null;
  let error = '';
  const visible = () => list.filter((t) => t.shared === opts.shared);
  const canEdit = () => (opts.shared ? opts.isAdmin : true);

  const draw = () => {
    const folders = [...new Set(list.map((t) => t.folder).filter(Boolean))];
    root.innerHTML = `<style>${CSS}</style><div class="rfm-tm-box">
<div class="rfm-tm-list"><div class="rfm-tm-list-head">${opts.shared ? 'Общие шаблоны' : 'Мои шаблоны'}${canEdit() ? '<button type="button" class="rfm-tm-btn" data-tm="new" style="margin-left:auto">+ Новый</button>' : ''}</div><div class="rfm-tm-items">${templateListHtml(visible(), current?.id ?? null)}</div></div>
${current ? templateFormHtml(current, { shared: opts.shared, canEdit: canEdit(), error }) : '<div class="rfm-tm-form"><div style="display:flex;justify-content:flex-end"><button type="button" class="rfm-tm-btn" data-tm="close">Закрыть</button></div><div class="rfm-tm-empty">Выберите шаблон слева или создайте новый.<br>Вызов в окне переписки: кнопка «/» или «/» в начале поля.</div></div>'}
<datalist id="rfm-tm-folders">${folders.map((f) => `<option value="${esc(f)}">`).join('')}</datalist></div>`;
  };
  const reload = async () => {
    list = (await chat.templates()).templates;
    draw();
  };
  const close = () => root.remove();
  const formValues = () => ({
    title: root.querySelector<HTMLInputElement>('input[name=title]')?.value.trim() ?? '',
    folder: root.querySelector<HTMLInputElement>('input[name=folder]')?.value.trim() ?? '',
    text: root.querySelector<HTMLTextAreaElement>('textarea[name=text]')?.value ?? '',
  });

  root.addEventListener('click', (e) => {
    if (e.target === root) return close();
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tm]');
    if (!btn) return;
    const act = btn.dataset.tm;
    if (act === 'close') return close();
    if (act === 'new') {
      current = { title: '', text: '', folder: '', attachments: [], shared: opts.shared };
      error = '';
      return draw();
    }
    if (act === 'pick') {
      current = { ...(list.find((t) => t.id === Number(btn.dataset.id)) ?? null) };
      error = '';
      return draw();
    }
    if (act === 'var') {
      const t = root.querySelector<HTMLTextAreaElement>('textarea[name=text]');
      if (!t) return;
      const s = t.selectionStart ?? t.value.length;
      t.value = t.value.slice(0, s) + (btn.dataset.v ?? '') + t.value.slice(t.selectionEnd ?? s);
      t.focus();
      return;
    }
    if (act === 'att') return root.querySelector<HTMLInputElement>('[data-tm-file]')?.click();
    if (act === 'unatt' && current) {
      Object.assign(current, formValues());
      current.attachments = (current.attachments ?? []).filter((_, i) => i !== Number(btn.dataset.i));
      return draw();
    }
    if (act === 'save' && current) {
      const body = { ...formValues(), attachments: current.attachments ?? [], shared: opts.shared };
      void (current.id ? chat.updateTemplate(current.id, body) : chat.createTemplate(body)).then(
        async (saved) => {
          current = saved;
          error = '';
          await reload();
        },
        (err: Error) => {
          Object.assign(current ?? {}, formValues());
          error = err.message;
          draw();
        },
      );
      return;
    }
    if (act === 'delete' && current?.id) {
      if (!w.confirm('Удалить шаблон?')) return;
      void chat.deleteTemplate(current.id).then(async () => {
        current = null;
        await reload();
      });
    }
  });
  root.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.matches('[data-tm-file]') || !input.files?.[0] || !current) return;
    const f = input.files[0];
    Object.assign(current, formValues());
    const target = current;
    void chat.upload(f, f.name, w).then(
      (u: UploadedFile) => {
        target.attachments = [...(target.attachments ?? []), { fileId: u.id, name: u.name, mime: u.mime, size: u.size }];
        draw();
      },
      (err: Error) => {
        error = err.message;
        draw();
      },
    );
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      doc.removeEventListener('keydown', onKey);
      close();
    }
  };
  doc.addEventListener('keydown', onKey);
  draw();
  await reload().catch((err: Error) => {
    error = err.message;
    current = { title: '', text: '', folder: '', attachments: [], shared: opts.shared };
    draw();
  });
  return close;
}
