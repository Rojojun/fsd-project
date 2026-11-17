import { test, expect } from '@playwright/test';
import { withServer, getTasks, ISO_8601_UTC } from './helpers.mjs';

test.describe('TASK-01 액션 아이템 목록 조회: GET /tasks', () => {
  test('S-1 [AC-1] 액션 아이템이 한 개 저장되어 있으면 200을 돌려준다', async ({ request }) => {
    const tasks = [{ id: 't1', title: '안건 정리', createdAt: '2026-11-10T09:00:00Z' }];
    await withServer(tasks, async (baseURL) => {
      const response = await request.get(`${baseURL}/tasks`);
      expect(response.status()).toBe(200);
    });
  });

  test('S-2 [AC-1] 액션 아이템이 여러 개 저장되어 있어도 200을 돌려준다', async ({ request }) => {
    const tasks = [
      { id: 't1', title: '안건 정리', createdAt: '2026-11-10T09:00:00Z' },
      { id: 't2', title: '회의실 예약', createdAt: '2026-11-11T09:00:00Z' },
      { id: 't3', title: '참석자 확인', createdAt: '2026-11-12T09:00:00Z' },
    ];
    await withServer(tasks, async (baseURL) => {
      const response = await request.get(`${baseURL}/tasks`);
      expect(response.status()).toBe(200);
    });
  });

  test('S-3 [AC-2] createdAt이 서로 다른 세 개가 저장되어 있으면 요소가 세 개인 JSON 배열을 돌려준다', async ({ request }) => {
    const tasks = [
      { id: 't1', title: '안건 정리', createdAt: '2026-11-10T09:00:00Z' },
      { id: 't2', title: '회의실 예약', createdAt: '2026-11-11T09:00:00Z' },
      { id: 't3', title: '참석자 확인', createdAt: '2026-11-12T09:00:00Z' },
    ];
    await withServer(tasks, async (baseURL) => {
      const { body } = await getTasks(request, baseURL);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(3);
      // 저장된 액션 아이템을 모두 담는다: 빠지거나 겹친 것이 없어야 한다.
      expect(body.map((task) => task.id).toSorted()).toEqual(['t1', 't2', 't3']);
    });
  });

  test('S-4 [AC-3] 하나만 저장되어 있으면 유일한 요소의 id, title, createdAt이 저장한 문자열 그대로다', async ({ request }) => {
    const tasks = [{ id: 'a1', title: '회의록 공유', createdAt: '2026-11-17T06:10:16Z' }];
    await withServer(tasks, async (baseURL) => {
      const { body } = await getTasks(request, baseURL);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      const [only] = body;
      // toBe는 타입까지 본다: 문자열이 아니면 실패한다.
      expect(only.id).toBe('a1');
      expect(only.title).toBe('회의록 공유');
      expect(only.createdAt).toBe('2026-11-17T06:10:16Z');
    });
  });

  test('S-5 [AC-4] 모든 요소의 createdAt은 ISO 8601 UTC 형식의 문자열이고, id와 title도 문자열이다', async ({ request }) => {
    const tasks = [
      { id: 't1', title: '안건 정리', createdAt: '2026-01-01T00:00:00Z' },
      { id: 't2', title: '회의실 예약', createdAt: '2026-11-17T06:10:16Z' },
      { id: 't3', title: '참석자 확인', createdAt: '2026-12-31T23:59:59Z' },
    ];
    await withServer(tasks, async (baseURL) => {
      const { body } = await getTasks(request, baseURL);
      expect(body).toHaveLength(3);
      for (const task of body) {
        expect(typeof task.createdAt, `createdAt 타입 (id=${task.id})`).toBe('string');
        expect(task.createdAt, `createdAt 형식 (id=${task.id})`).toMatch(ISO_8601_UTC);
        expect(Number.isNaN(Date.parse(task.createdAt)), `createdAt이 실제 날짜인가 (id=${task.id})`).toBe(false);
        expect(typeof task.id).toBe('string');
        expect(typeof task.title).toBe('string');
      }
      // 저장한 시각이 그대로 나온다(다른 시각으로 바뀌지 않는다).
      expect(body.map((task) => task.createdAt).toSorted()).toEqual([
        '2026-01-01T00:00:00Z',
        '2026-11-17T06:10:16Z',
        '2026-12-31T23:59:59Z',
      ]);
    });
  });

  test('S-6 [AC-5] 15일, 17일, 16일 순서로 저장되어 있으면 17일, 16일, 15일 순서로 돌려준다', async ({ request }) => {
    const tasks = [
      { id: 'd15', title: '15일 항목', createdAt: '2026-11-15T00:00:00Z' },
      { id: 'd17', title: '17일 항목', createdAt: '2026-11-17T00:00:00Z' },
      { id: 'd16', title: '16일 항목', createdAt: '2026-11-16T00:00:00Z' },
    ];
    await withServer(tasks, async (baseURL) => {
      const { body } = await getTasks(request, baseURL);
      expect(body.map((task) => task.createdAt)).toEqual([
        '2026-11-17T00:00:00Z',
        '2026-11-16T00:00:00Z',
        '2026-11-15T00:00:00Z',
      ]);
      // 정렬하면서 항목의 다른 필드가 뒤섞이지 않는다.
      expect(body.map((task) => task.id)).toEqual(['d17', 'd16', 'd15']);
      expect(body.map((task) => task.title)).toEqual(['17일 항목', '16일 항목', '15일 항목']);
    });
  });

  test('S-7 [AC-5] 이미 최신순이거나 오래된 순으로 저장되어 있어도 최신 것부터 돌려준다', async ({ request }) => {
    const newestFirst = [
      { id: 'n3', title: '셋째', createdAt: '2026-11-17T12:00:00Z' },
      { id: 'n2', title: '둘째', createdAt: '2026-11-17T06:00:00Z' },
      { id: 'n1', title: '첫째', createdAt: '2026-10-01T00:00:00Z' },
    ];
    await withServer(newestFirst, async (baseURL) => {
      const { body } = await getTasks(request, baseURL);
      expect(body.map((task) => task.id)).toEqual(['n3', 'n2', 'n1']);
    });
    await withServer(newestFirst.toReversed(), async (baseURL) => {
      const { body } = await getTasks(request, baseURL);
      expect(body.map((task) => task.id)).toEqual(['n3', 'n2', 'n1']);
    });
  });

  test('S-8 [AC-6, AC-7] 액션 아이템이 하나도 없으면 200과 빈 JSON 배열 []을 돌려준다', async ({ request }) => {
    // 데이터를 주지 않고 띄운 서버
    await withServer(undefined, async (baseURL) => {
      const { status, text, body } = await getTasks(request, baseURL);
      expect(status).toBe(200);
      expect(body).toEqual([]);
      expect(text.trim()).toBe('[]');
    });
    // 빈 목록을 주고 띄운 서버
    await withServer([], async (baseURL) => {
      const { status, body } = await getTasks(request, baseURL);
      expect(status).toBe(200);
      expect(body).toEqual([]);
    });
  });

  test('S-9 [AC-2, AC-5, AC-6] 같은 요청을 다시 해도 같은 상태 코드와 같은 본문을 돌려준다', async ({ request }) => {
    const tasks = [
      { id: 'd15', title: '15일 항목', createdAt: '2026-11-15T00:00:00Z' },
      { id: 'd17', title: '17일 항목', createdAt: '2026-11-17T00:00:00Z' },
      { id: 'd16', title: '16일 항목', createdAt: '2026-11-16T00:00:00Z' },
    ];
    await withServer(tasks, async (baseURL) => {
      const first = await getTasks(request, baseURL);
      const second = await getTasks(request, baseURL);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.map((task) => task.id)).toEqual(['d17', 'd16', 'd15']);
      expect(second.body).toEqual(first.body);
    });
    await withServer([], async (baseURL) => {
      const first = await getTasks(request, baseURL);
      const second = await getTasks(request, baseURL);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body).toEqual([]);
      expect(second.body).toEqual([]);
    });
  });
});
