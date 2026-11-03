import { fileURLToPath } from 'node:url';

/** Миграции БД базы знаний (ai_door_opt_kb); в образе Docker путь задаётся KB_MIGRATIONS_DIR. */
export const KB_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
