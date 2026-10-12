import type { AmoLead, AmoUser } from './client.ts';

export type AssigneeReason = 'forced' | 'responsible' | 'fallback' | 'admin' | 'none';

/** Кому ставится задача агента и почему. */
export interface TaskAssignee {
  userId: number | null;
  name: string | null;
  reason: AssigneeReason;
}

export interface AssigneeOptions {
  /** «Всегда ставить задачи этому пользователю» — принудительно, минуя ответственного (не рекомендуется). */
  forcedUserId?: number | null;
  /** «Администратор для задач» — когда у сделки нет активного ответственного. */
  fallbackUserId?: number | null;
}

/** Минимум API, нужный резолверу (удобно подменять в тестах). */
export interface AssigneeApi {
  readonly domain: string;
  getLead(id: number): Promise<Pick<AmoLead, 'responsible_user_id'> | null>;
  listUsers(): Promise<AmoUser[]>;
}

const USERS_TTL_MS = 10 * 60_000;
const usersCache = new Map<string, { at: number; users: AmoUser[] }>();

/** Список пользователей аккаунта с кэшем 10 мин (ключ — домен аккаунта). */
export async function cachedUsers(api: AssigneeApi, now = Date.now()): Promise<AmoUser[]> {
  const hit = usersCache.get(api.domain);
  if (hit && now - hit.at < USERS_TTL_MS) return hit.users;
  const users = await api.listUsers();
  usersCache.set(api.domain, { at: now, users });
  return users;
}

export function clearUsersCache(): void {
  usersCache.clear();
}

/**
 * Правило выбора: принудительный пользователь (если активен) → ответственный по сделке (если активен)
 * → «администратор для задач» (если активен) → первый активный администратор → никого.
 */
export function pickAssignee(users: AmoUser[], responsibleUserId: number | null | undefined, opts: AssigneeOptions = {}): TaskAssignee {
  const byId = (id: number | null | undefined) => (id ? (users.find((u) => u.id === id) ?? null) : null);
  const forced = byId(opts.forcedUserId);
  if (forced?.isActive) return { userId: forced.id, name: forced.name, reason: 'forced' };
  const responsible = byId(responsibleUserId);
  if (responsible?.isActive) return { userId: responsible.id, name: responsible.name, reason: 'responsible' };
  const fallback = byId(opts.fallbackUserId);
  if (fallback?.isActive) return { userId: fallback.id, name: fallback.name, reason: 'fallback' };
  const admin = users.find((u) => u.isActive && u.isAdmin);
  if (admin) return { userId: admin.id, name: admin.name, reason: 'admin' };
  return { userId: null, name: null, reason: 'none' };
}

/** Получатель задачи по сделке. Если список пользователей недоступен — доверяем ответственному из сделки. */
export async function resolveTaskAssignee(api: AssigneeApi, leadId: number, opts: AssigneeOptions = {}): Promise<TaskAssignee> {
  const [lead, users] = await Promise.all([api.getLead(leadId), cachedUsers(api).catch(() => [] as AmoUser[])]);
  const responsibleUserId = lead?.responsible_user_id ?? null;
  if (!users.length) {
    const userId = opts.forcedUserId ?? responsibleUserId;
    return { userId, name: null, reason: userId ? (opts.forcedUserId ? 'forced' : 'responsible') : 'none' };
  }
  return pickAssignee(users, responsibleUserId, opts);
}
