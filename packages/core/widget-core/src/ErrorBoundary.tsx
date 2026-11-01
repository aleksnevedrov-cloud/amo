import { Component, type ErrorInfo, type ReactNode } from 'react';
import { s } from './styles.ts';

/**
 * Ошибка внутри панели или настроек не должна ломать карточку amo и другие виджеты:
 * показываем короткое сообщение и пишем в консоль (требование модерации Маркетплейса).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console -- единственный канал диагностики внутри amo
    console.error('[ai-door] render error', error, info.componentStack);
  }

  override render() {
    if (this.state.failed) {
      return (
        <div style={{ ...s.root, ...s.error }}>
          AI-агент: не удалось отобразить блок.{' '}
          <button type="button" style={s.buttonGhost} onClick={() => this.setState({ failed: false })}>
            Повторить
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
