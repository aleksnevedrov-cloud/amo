import { z } from 'zod';

/**
 * Переменные базы знаний опта (RFD-AI-AGENT-OPT-KB). Читаются отдельно от общего @core/shared:
 * ядро не меняется, у розницы этих переменных нет.
 */
export const kbEnvSchema = z.object({
  /** Отдельная БД в контейнере opt-kb-db: postgresql://aidoor_opt_kb:<пароль>@opt-kb-db:5432/ai_door_opt_kb */
  KB_DATABASE_URL: z.string().url(),
  /** Том opt-kb-files: копии загруженных файлов и текстов для переиндексации. */
  KB_FILES_ROOT: z.string().default('/kb-files'),
  /** Модель эмбеддингов OpenAI; размерность фиксирована схемой (1536). */
  KB_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
});

export type KbEnv = z.infer<typeof kbEnvSchema>;

export function loadKbEnv(source: NodeJS.ProcessEnv = process.env): KbEnv {
  const parsed = kbEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Некорректная конфигурация базы знаний опта:\n${issues}`);
  }
  return parsed.data;
}
