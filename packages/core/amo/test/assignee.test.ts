import { beforeEach, describe, expect, it } from 'vitest';
import { clearUsersCache, pickAssignee, resolveTaskAssignee, type AmoUser } from '../src/index.ts';

const users: AmoUser[] = [
  { id: 1, name: 'Александр', email: null, isActive: true, isAdmin: true },
  { id: 2, name: 'Сергей', email: null, isActive: true, isAdmin: false },
  { id: 3, name: 'Уволенный', email: null, isActive: false, isAdmin: false },
  { id: 4, name: 'Данила', email: null, isActive: true, isAdmin: false },
];

describe('pickAssignee — получатель задачи агента', () => {
  it('активный ответственный по сделке → он', () => {
    expect(pickAssignee(users, 2)).toMatchObject({ userId: 2, name: 'Сергей', reason: 'responsible' });
  });
  it('ответственный деактивирован → «администратор для задач»', () => {
    expect(pickAssignee(users, 3, { fallbackUserId: 4 })).toMatchObject({ userId: 4, reason: 'fallback' });
  });
  it('ответственного нет, fallback пуст → первый активный администратор', () => {
    expect(pickAssignee(users, null)).toMatchObject({ userId: 1, name: 'Александр', reason: 'admin' });
  });
  it('fallback тоже неактивен → администратор', () => {
    expect(pickAssignee(users, 3, { fallbackUserId: 3 })).toMatchObject({ userId: 1, reason: 'admin' });
  });
  it('принудительный пользователь активен → он, минуя ответственного', () => {
    expect(pickAssignee(users, 2, { forcedUserId: 4 })).toMatchObject({ userId: 4, reason: 'forced' });
  });
  it('никого активного → none', () => {
    expect(pickAssignee([{ id: 9, name: 'x', email: null, isActive: false, isAdmin: true }], 9)).toEqual({ userId: null, name: null, reason: 'none' });
  });
});

describe('resolveTaskAssignee', () => {
  beforeEach(() => clearUsersCache());

  it('берёт ответственного из сделки, список пользователей кэшируется', async () => {
    let calls = 0;
    const api = {
      domain: 'test.amocrm.ru',
      getLead: async () => ({ responsible_user_id: 2 }),
      listUsers: async () => {
        calls += 1;
        return users;
      },
    };
    expect(await resolveTaskAssignee(api, 1)).toMatchObject({ userId: 2, reason: 'responsible' });
    expect(await resolveTaskAssignee(api, 1, { fallbackUserId: 4 })).toMatchObject({ userId: 2 });
    expect(calls).toBe(1);
  });

  it('список пользователей недоступен → ответственный из сделки без проверки активности', async () => {
    const api = {
      domain: 'x.amocrm.ru',
      getLead: async () => ({ responsible_user_id: 7 }),
      listUsers: async () => {
        throw new Error('403');
      },
    };
    expect(await resolveTaskAssignee(api, 1)).toEqual({ userId: 7, name: null, reason: 'responsible' });
  });
});
