import { fileURLToPath } from 'node:url';

/** Миграции БД опта (ai_door_opt); в образе Docker путь задаётся MIGRATIONS_DIR. */
export const OPT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
