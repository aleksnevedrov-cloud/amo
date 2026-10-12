// Архив виджета «AI-продавец»: общая сборка из @ai-door/widget-core, здесь только вход и имя бандла.
import { buildWidgetArchive } from '@ai-door/widget-core/build';

await buildWidgetArchive({ root: new URL('..', import.meta.url), globalName: '__aiDoorWidget' });
