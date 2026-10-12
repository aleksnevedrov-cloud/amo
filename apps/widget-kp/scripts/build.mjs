// Архив виджета «АИ-агент КП»: общая сборка из @ai-door/widget-core, здесь только вход и имя бандла.
import { buildWidgetArchive } from '@ai-door/widget-core/build';

await buildWidgetArchive({ root: new URL('..', import.meta.url), globalName: '__aiDoorKpWidget' });
