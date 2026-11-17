import { test, expect } from '@playwright/test';
import { withServer, getTasks, completeTask, findById } from './helpers.mjs';

const A1 = { id: 'a1', title: '회의록 공유', createdAt: '2026-11-17T06:10:16Z' };
const A2 = { id: 'a2', title: '회의실 예약', createdAt: '2026-11-16T03:00:00Z' };
const A3 = { id: 'a3', title: '참석자 확인', createdAt: '2026-11-15T01:30:00Z' };

const THREE_DAYS = [
  { id: 'd15', title: '15일 항목', createdAt: '2026-11-15T00:00:00Z' },
  { id: 'd16', title: '16일 항목', createdAt: '2026-11-16T00:00:00Z' },
  { id: 'd17', title: '17일 항목', createdAt: '2026-11-17T00:00:00Z' },
];
const NEWEST_FIRST = ['2026-11-17T00:00:00Z', '2026-11-16T00:00:00Z', '2026-11-15T00:00:00Z'];

test.describe('TASK-02 액션 아이템 완료 처리: POST /tasks/{id}/complete', () => {
  test('S-1 [AC-1] 완료되지 않은 a1에 완료를 요청하면 200을 돌려준다', async ({ request }) => {
    await withServer([A1], async (baseURL) => {
      const { status } = await completeTask(request, baseURL, 'a1');
      expect(status).toBe(200);
    });
  });

  test('S-2 [AC-2] 완료 응답 본문은 id, title, createdAt이 그대로이고 completed가 true인 JSON 객체다', async ({ request }) => {
    await withServer([A1], async (baseURL) => {
      const { status, text } = await completeTask(request, baseURL, 'a1');
      expect(status).toBe(200);
      const body = JSON.parse(text);
      expect(body === null || Array.isArray(body) || typeof body !== 'object', '본문이 JSON 객체인가').toBe(false);
      // toBe는 타입까지 본다.
      expect(body.id).toBe('a1');
      expect(body.title).toBe('회의록 공유');
      expect(body.createdAt).toBe('2026-11-17T06:10:16Z');
      expect(body.completed).toBe(true);
    });
  });

  test('S-3 [AC-3] a1을 완료한 뒤 목록을 조회하면 a1의 completed는 true다', async ({ request }) => {
    await withServer([A1], async (baseURL) => {
      expect((await getTasks(request, baseURL)).body[0].completed, '완료 전에는 false').toBe(false);
      expect((await completeTask(request, baseURL, 'a1')).status).toBe(200);
      const { status, body } = await getTasks(request, baseURL);
      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      const a1 = findById(body, 'a1');
      expect(a1.completed).toBe(true);
      // 완료해도 다른 필드는 그대로다.
      expect(a1.title).toBe('회의록 공유');
      expect(a1.createdAt).toBe('2026-11-17T06:10:16Z');
    });
  });

  test('S-4 [AC-4] a1만 완료하면 a2의 completed는 false 그대로다', async ({ request }) => {
    await withServer([A1, A2], async (baseURL) => {
      expect((await completeTask(request, baseURL, 'a1')).status).toBe(200);
      const { body } = await getTasks(request, baseURL);
      expect(body).toHaveLength(2);
      expect(findById(body, 'a2').completed).toBe(false);
      expect(findById(body, 'a1').completed).toBe(true);
    });
  });

  test('S-5 [AC-4] 여럿 가운데 가운데 것 하나만 완료해도 나머지는 모두 false 그대로다', async ({ request }) => {
    await withServer([A1, A2, A3], async (baseURL) => {
      expect((await completeTask(request, baseURL, 'a2')).status).toBe(200);
      const { body } = await getTasks(request, baseURL);
      expect(body).toHaveLength(3);
      expect(findById(body, 'a1').completed).toBe(false);
      expect(findById(body, 'a2').completed).toBe(true);
      expect(findById(body, 'a3').completed).toBe(false);
    });
  });

  test('S-6 [AC-5] 완료된 것과 완료되지 않은 것이 섞여 있어도 모든 요소에 불리언 completed가 있다', async ({ request }) => {
    await withServer([A1, A2, A3], async (baseURL) => {
      expect((await completeTask(request, baseURL, 'a1')).status).toBe(200);
      const { status, body } = await getTasks(request, baseURL);
      expect(status).toBe(200);
      expect(body).toHaveLength(3);
      for (const task of body) {
        expect(Object.hasOwn(task, 'completed'), `completed 필드가 있는가 (id=${task.id})`).toBe(true);
        expect(typeof task.completed, `completed 타입 (id=${task.id})`).toBe('boolean');
        // 요소의 필드는 id, title, createdAt, completed다.
        expect(typeof task.id).toBe('string');
        expect(typeof task.title).toBe('string');
        expect(typeof task.createdAt).toBe('string');
      }
      expect(Object.fromEntries(body.map((task) => [task.id, task.completed]))).toEqual({
        a1: true,
        a2: false,
        a3: false,
      });
    });
  });

  test('S-7 [AC-5] 아무것도 완료하지 않았어도 모든 요소에 completed가 false로 들어간다', async ({ request }) => {
    await withServer([A1, A2], async (baseURL) => {
      const { status, body } = await getTasks(request, baseURL);
      expect(status).toBe(200);
      expect(body).toHaveLength(2);
      for (const task of body) {
        expect(task.completed, `completed (id=${task.id})`).toBe(false);
      }
    });
  });

  test('S-8 [AC-6] 없는 ID none에 완료를 요청하면 404를 돌려주고 다른 액션 아이템은 바뀌지 않는다', async ({ request }) => {
    await withServer([A1, A2], async (baseURL) => {
      const { status } = await completeTask(request, baseURL, 'none');
      expect(status).toBe(404);
      const { body } = await getTasks(request, baseURL);
      expect(body).toHaveLength(2);
      expect(findById(body, 'none')).toBeUndefined();
      expect(findById(body, 'a1').completed).toBe(false);
      expect(findById(body, 'a2').completed).toBe(false);
    });
  });

  test('S-9 [AC-6] 액션 아이템이 하나도 없을 때도 404를 돌려주고 목록은 빈 배열 그대로다', async ({ request }) => {
    await withServer(undefined, async (baseURL) => {
      expect((await completeTask(request, baseURL, 'none')).status).toBe(404);
      // 같은 요청을 다시 해도 404다.
      expect((await completeTask(request, baseURL, 'none')).status).toBe(404);
      const { status, body } = await getTasks(request, baseURL);
      expect(status).toBe(200);
      expect(body).toEqual([]);
    });
  });

  test('S-10 [AC-7] 이미 완료된 a1에 다시 완료를 요청해도 200을 돌려준다', async ({ request }) => {
    await withServer([A1], async (baseURL) => {
      // 조건: 실제 요청으로 a1을 완료해 둔다.
      expect((await completeTask(request, baseURL, 'a1')).status).toBe(200);
      const again = await completeTask(request, baseURL, 'a1');
      expect(again.status).toBe(200);
    });
  });

  test('S-11 [AC-8] 다시 요청한 응답 본문은 첫 응답 본문과 같은 JSON 객체다', async ({ request }) => {
    await withServer([A1, A2], async (baseURL) => {
      const first = await completeTask(request, baseURL, 'a1');
      expect(first.status).toBe(200);
      const firstBody = JSON.parse(first.text);
      const second = await completeTask(request, baseURL, 'a1');
      const third = await completeTask(request, baseURL, 'a1');
      for (const repeat of [second, third]) {
        expect(repeat.status).toBe(200);
        const body = JSON.parse(repeat.text);
        expect(body).toEqual(firstBody);
        expect(body.completed).toBe(true);
        expect(body.id).toBe('a1');
        expect(body.title).toBe('회의록 공유');
        expect(body.createdAt).toBe('2026-11-17T06:10:16Z');
      }
    });
  });

  test('S-12 [AC-9] a1에 완료를 두 번 요청한 뒤에도 목록에서 a1은 완료 상태이고 다른 것은 그대로다', async ({ request }) => {
    await withServer([A1, A2], async (baseURL) => {
      await completeTask(request, baseURL, 'a1');
      await completeTask(request, baseURL, 'a1');
      const { status, body } = await getTasks(request, baseURL);
      expect(status).toBe(200);
      // 두 번 요청해도 항목이 늘거나 줄지 않는다.
      expect(body).toHaveLength(2);
      expect(findById(body, 'a1').completed).toBe(true);
      expect(findById(body, 'a2').completed).toBe(false);
    });
  });

  test('S-13 [AC-10] 17일 것만 완료되어 있어도 목록은 17일, 16일, 15일 순서다', async ({ request }) => {
    await withServer(THREE_DAYS, async (baseURL) => {
      expect((await completeTask(request, baseURL, 'd17')).status).toBe(200);
      const { body } = await getTasks(request, baseURL);
      expect(body.map((task) => task.createdAt)).toEqual(NEWEST_FIRST);
      expect(body.map((task) => task.id)).toEqual(['d17', 'd16', 'd15']);
      expect(body.map((task) => task.completed)).toEqual([true, false, false]);
    });
  });

  test('S-14 [AC-10] 가장 오래된 것이나 가운데 것을 완료해도 정렬은 createdAt 내림차순 그대로다', async ({ request }) => {
    // 가장 오래된 것만 완료
    await withServer(THREE_DAYS, async (baseURL) => {
      expect((await completeTask(request, baseURL, 'd15')).status).toBe(200);
      const { body } = await getTasks(request, baseURL);
      expect(body.map((task) => task.createdAt)).toEqual(NEWEST_FIRST);
      expect(body.map((task) => task.completed)).toEqual([false, false, true]);
    });
    // 가운데와 가장 오래된 것을 완료 (저장 순서도 뒤섞어 둔다)
    const shuffled = [THREE_DAYS[1], THREE_DAYS[2], THREE_DAYS[0]];
    await withServer(shuffled, async (baseURL) => {
      expect((await completeTask(request, baseURL, 'd16')).status).toBe(200);
      expect((await completeTask(request, baseURL, 'd15')).status).toBe(200);
      const { body } = await getTasks(request, baseURL);
      expect(body.map((task) => task.createdAt)).toEqual(NEWEST_FIRST);
      expect(body.map((task) => task.completed)).toEqual([false, true, true]);
    });
  });

  test('S-15 [AC-2, AC-3] 완료 응답의 객체는 목록 조회에 나오는 그 요소와 같다', async ({ request }) => {
    await withServer([A1, A2], async (baseURL) => {
      const { status, text } = await completeTask(request, baseURL, 'a2');
      expect(status).toBe(200);
      const completed = JSON.parse(text);
      const { body } = await getTasks(request, baseURL);
      // 완료 응답의 필드는 목록 조회의 요소와 같다.
      expect(findById(body, 'a2')).toEqual(completed);
      expect(completed).toMatchObject({ ...A2, completed: true });
    });
  });

  test('S-16 [AC-3, AC-5] 저장된 것을 모두 완료하면 모든 요소의 completed가 true다', async ({ request }) => {
    await withServer([A1, A2, A3], async (baseURL) => {
      for (const id of ['a3', 'a1', 'a2']) {
        expect((await completeTask(request, baseURL, id)).status, `완료 요청 (id=${id})`).toBe(200);
      }
      const { body } = await getTasks(request, baseURL);
      expect(body).toHaveLength(3);
      expect(body.map((task) => task.completed)).toEqual([true, true, true]);
      // 정렬은 그대로 createdAt 내림차순이다.
      expect(body.map((task) => task.id)).toEqual(['a1', 'a2', 'a3']);
    });
  });
});
