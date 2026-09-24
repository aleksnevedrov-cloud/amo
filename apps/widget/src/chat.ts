/**
 * Вставка текста в поле ответа чата в карточке amo. Разметка amo не документирована —
 * ищем редактируемое поле в блоке отправки; если не нашли, копируем в буфер обмена.
 * Селекторы сверить на живом аккаунте.
 */
export async function insertIntoChat(text: string): Promise<'inserted' | 'copied' | 'failed'> {
  const field = document.querySelector<HTMLElement>(
    '.feed-compose [contenteditable="true"], .feed-compose textarea, .js-feed-compose-input [contenteditable="true"]',
  );
  if (field) {
    field.focus();
    if (field instanceof HTMLTextAreaElement) field.value = text;
    else field.innerText = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return 'inserted';
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/** base64 файла для загрузки через $authorizedAjax (JSON). */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function downloadBase64(base64: string, name: string, mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
  const a = document.createElement('a');
  a.href = `data:${mime};base64,${base64}`;
  a.download = name;
  a.click();
}
