import { test, expect } from '@playwright/test';
import { withServer, getTasks, completeTask, ISO_8601_UTC, TASK_FIELDS } from './helpers.mjs';

const THREE = [
  { id: 't1', title: '안건 정리', createdAt: '2026-11-10T09:00:00Z' },
  { id: 't2', title: '회의실 예약', createdAt: '2026-11-11T09:00:00Z' },
  { id: 't3', title: '참석자 확인', createdAt: '2026-11-12T09:00:00Z' },
];

// AC-6: 15일, 17일, 16일 순서로 저장
const SHUFFLED = [
  { id: 'd15', title: '15일 항목', createdAt: '2026-11-15T00:00:00Z' },
  { id: 'd17', title: '17일 항목', createdAt: '2026-11-17T00:00:00Z' },
  { id: 'd16', title: '16일 항목', createdAt: '2026-11-16T00:00:00Z' },
];

test.describe('TASK-01 액션 아이템 목록 조회: GET /tasks', () => {
  test('S-1 [AC-1] 액션 아이템이 한 개 저장되어 있으면 200을 돌려준다', async ({ request }) => {
    await withServer([THREE[0]], async (baseURL) => {
      const response = await request.get(`${baseURL}/tasks`);
      expect(response.status()).toBe(200);
    });
  });

  test('S-2 [AC-1] 액션 아이템이 여러 개 저장되어 있어도 200을 돌려준다', async ({ request }) => {
    await withServer(THREE, async (baseURL) => {
      const response = await request.get(`${baseURL}/tasks`);
      expect(response.status()).toBe(200);
    });
  });

  test('S-3 [AC-2] createdAt이 서로 다른 세 개가 저장되어 있으면 요소가 세 개인 JSON 배열을 돌려준다', async ({ request }) => {
    await withServer(THREE, async (baseURL) => {
      const { body } = await getTasks(request, baseURL);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(3);
      // 저장된 액션 아이템을 모두 담는다: 빠지거나 겹친 것이 없어야 한다.
      expect(body.map((task) => task.id).toSorted()).toEqual(['t1', 't2', 't3']);
    });
  });

  test('S-4 [AC-3] 완료되지 않은 하나만 저장되어 있으면 유일한 요소가 id, title, createdAt, completed:false를 그대로 담는다', async ({ request }) => {
    // 저장만 하고 완료 처리는 하지 않는다 = 완료되지 않은 액션 아이템
    const tasks = [{ id: 'a1', title: '회의록 공유', createdAt: '2026-11-17T06:10:16Z' }];
    await withServer(tasks, async (baseURL) => {
      const { body } = await getTasks(request, baseURL);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      const [only] = body;
      for (const field of TASK_FIELDS) {
        expect(Object.hasOwn(only, field), `${field} 필드가 있는가`).toBe(true);
      }
      // toBe는 타입까지 본다: 문자열·불리언이 아니면 실패한다.
      expect(only.id).toBe('a1');
      expect(only.title).toBe('회의록 공유');
      expect(only.createdAt).toBe('2026-11-17T06:10:16Z');
      expect(only.completed).toBe(false);
    });
  });

  test('S-5 [AC-4] 모든 요소의 createdAt은 ISO 8601 UTC 형식의 문자열이다', async ({ request }) => {
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

  test('S-6 [AC-5] 완료 전·후 항목이 섞여 있어도 모든 요소에 불리언 completed가 있다', async ({ request }) => {
    await withServer(THREE, async (baseURL) => {
      // 완료 전: 모두 false
      const before = await getTasks(request, baseURL);
      expect(before.body).toHaveLength(3);
      for (const task of before.body) {
        expect(Object.hasOwn(task, 'completed'), `completed 필드 (id=${task.id})`).toBe(true);
        expect(task.completed, `완료 전 completed (id=${task.id})`).toBe(false);
      }

      // t2만 완료 처리(TASK-02의 실제 경로)
      expect(await completeTask(request, baseURL, 't2')).toBe(200);

      const after = await getTasks(request, baseURL);
      expect(after.body).toHaveLength(3);
      for (const task of after.body) {
        expect(typeof task.completed, `completed 타입 (id=${task.id})`).toBe('boolean');
      }
      const completedById = Object.fromEntries(after.body.map((task) => [task.id, task.completed]));
      expect(completedById).toEqual({ t1: false, t2: true, t3: false });
    });
  });

  test('S-7 [AC-6] 15일, 17일, 16일 순서로 저장되어 있으면 17일, 16일, 15일 순서로 돌려준다', async ({ request }) => {
    await withServer(SHUFFLED, async (baseURL) => {
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

  test('S-8 [AC-6] 이미 최신순이거나 오래된 순으로 저장되어 있어도 최신 것부터 돌려준다', async ({ request }) => {
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

  test('S-9 [AC-6] 일부를 완료해도 정렬은 completed와 무관하게 생성일 내림차순이다', async ({ request }) => {
    // 가장 최신(d17)과 가장 오래된(d15)을 각각 따로 완료해 본다.
    for (const doneId of ['d17', 'd15']) {
      await withServer(SHUFFLED, async (baseURL) => {
        expect(await completeTask(request, baseURL, doneId)).toBe(200);
        const { status, body } = await getTasks(request, baseURL);
        expect(status).toBe(200);
        expect(body.map((task) => task.createdAt), `${doneId} 완료 후 순서`).toEqual([
          '2026-11-17T00:00:00Z',
          '2026-11-16T00:00:00Z',
          '2026-11-15T00:00:00Z',
        ]);
        expect(body.map((task) => task.completed)).toEqual(
          ['d17', 'd16', 'd15'].map((id) => id === doneId),
        );
      });
    }
  });

  test('S-10 [AC-7, AC-8] 액션 아이템이 하나도 없으면 200과 빈 JSON 배열 []을 돌려준다', async ({ request }) => {
    // 데이터를 주지 않고 띄운 서버
    await withServer(undefined, async (baseURL) => {
      const { status, text, body } = await getTasks(request, baseURL);
      expect(status).toBe(200);
      expect(body).toEqual([]);
      expect(text.trim()).toBe('[]');
    });
    // 빈 목록을 주고 띄운 서버
    await withServer([], async (baseURL) => {
      const { status, text, body } = await getTasks(request, baseURL);
      expect(status).toBe(200);
      expect(body).toEqual([]);
      expect(text.trim()).toBe('[]');
    });
  });

  test('S-11 [AC-2, AC-6, AC-7, AC-8] 같은 요청을 다시 해도 같은 상태 코드와 같은 본문을 돌려준다', async ({ request }) => {
    await withServer(SHUFFLED, async (baseURL) => {
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
