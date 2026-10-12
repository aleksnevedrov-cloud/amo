import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ErrorBoundary } from './ErrorBoundary.tsx';

const STYLE_TAG_ID = 'ai-door-styles';

/**
 * Стилевой слой (styles.css из этого пакета) вшивается в бандл сборкой (define __STYLES__)
 * и вставляется в документ один раз. Оба виджета несут один и тот же CSS, поэтому тег общий.
 */
export function ensureStyles(css: string): void {
  if (!css || typeof document === 'undefined' || document.getElementById(STYLE_TAG_ID)) return;
  const tag = document.createElement('style');
  tag.id = STYLE_TAG_ID;
  tag.textContent = css;
  document.head.appendChild(tag);
}

/** React-корни виджета по ключу области (lcard, settings, advanced): повторный mount заменяет старый корень. */
export function createMounter(css: string) {
  const roots = new Map<string, Root>();
  return {
    mount(key: string, el: Element | null, node: ReactNode) {
      if (!el) return;
      ensureStyles(css);
      roots.get(key)?.unmount();
      const root = createRoot(el);
      root.render(<ErrorBoundary>{node}</ErrorBoundary>);
      roots.set(key, root);
    },
    unmountAll() {
      for (const root of roots.values()) root.unmount();
      roots.clear();
    },
  };
}

/** Обёртка колбэка amo: ошибка виджета не должна ломать карточку и другие виджеты. */
export const safe =
  <A extends unknown[]>(fn: (...args: A) => unknown) =>
  (...args: A) => {
    try {
      fn(...args);
    } catch (err) {
      // eslint-disable-next-line no-console -- единственный канал диагностики внутри amo
      console.error('[ai-door] widget error', err);
    }
    return true;
  };

/** Адрес страницы расширенных настроек виджета в amo (локация advanced_settings). */
export function advancedSettingsUrl(widgetCode: string, origin: string = typeof location === 'undefined' ? '' : location.origin): string {
  return `${origin}/settings/widgets/${encodeURIComponent(widgetCode)}/`;
}

/** Блок настроек в модальном окне интеграции: amo передаёт jQuery-объект окна. */
export function settingsHost(modal: unknown): Element | null {
  const m = modal as { find?: (sel: string) => { get?: (i: number) => Element | undefined } } | undefined;
  const block = m?.find?.('.widget_settings_block')?.get?.(0);
  if (!block) return null;
  const host = document.createElement('div');
  block.appendChild(host);
  return host;
}
