// Архив виджета «Агент опт»: общая сборка из @core/widget-core, здесь только вход и имя бандла.
import { buildWidgetArchive } from '@core/widget-core/build';

await buildWidgetArchive({ root: new URL('..', import.meta.url), globalName: '__aiDoorOptWidget' });
