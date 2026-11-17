import { test, expect } from '@playwright/test';
import {
  withServer, task, completeViaApi, trackRequests, gate,
  items, row, completeButton, expectOrder, expectDone, expectNotDone, TEXT,
} from './helpers.mjs';

test.use({ timezoneId: 'UTC' });

const A1 = task('a1', '회의록 공유', '2026-11-17T06:10:16Z');
const ABC = [
  task('ta', 'A', '2026-11-15T00:00:00Z'),
  task('tb', 'B', '2026-11-17T00:00:00Z'),
  task('tc', 'C', '2026-11-16T00:00:00Z'),
];

test.describe('UI-01 화면 주소', () => {
  test('S-1 [AC-1] GET /는 200과 text/html을 돌려주고 브라우저로 열린다', async ({ page, request }) => {
    await withServer([], async (baseURL) => {
      const api = await request.get(`${baseURL}/`);
      expect(api.status()).toBe(200);
      expect(api.headers()['content-type']).toMatch(/^text\/html/);

      const response = await page.goto(`${baseURL}/`);
      expect(response.status()).toBe(200);
      await expect(page.getByRole('heading', { name: TEXT.heading, exact: true })).toBeVisible();
    });
  });
});

test.describe('UI-01 내용 있음', () => {
  test('S-2 [AC-2] 저장된 "회의록 공유"가 목록(ul)의 항목(li)에 보인다', async ({ page }) => {
    await withServer([A1], async (baseURL) => {
      await page.goto(`${baseURL}/`);
      await expect(items(page)).toHaveCount(1);
      await expect(items(page).first().getByText('회의록 공유', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: TEXT.heading, exact: true })).toBeVisible();
    });
  });

  test('S-3 [AC-3] 목록은 GET /tasks 응답 순서(B, C, A)대로 보인다', async ({ page, request }) => {
    await withServer(ABC, async (baseURL) => {
      const apiOrder = (await (await request.get(`${baseURL}/tasks`)).json()).map((t) => t.title);
      expect(apiOrder).toEqual(['B', 'C', 'A']);
      await page.goto(`${baseURL}/`);
      await expectOrder(page, ['B', 'C', 'A']);
    });
  });

  test('S-4 [AC-3] 화면은 다시 정렬하지 않는다: GET /tasks가 돌려준 순서가 날짜 순이 아니어도 그대로 보인다', async ({ page }) => {
    await withServer(ABC, async (baseURL) => {
      const shuffled = [
        { id: 'ta', title: 'A', createdAt: '2026-11-15T00:00:00Z', completed: false },
        { id: 'tb', title: 'B', createdAt: '2026-11-17T00:00:00Z', completed: false },
        { id: 'tc', title: 'C', createdAt: '2026-11-16T00:00:00Z', completed: false },
      ];
      await page.route('**/tasks', (route) =>
        route.request().method() === 'GET' ? route.fulfill({ json: shuffled }) : route.continue());
      await page.goto(`${baseURL}/`);
      await expectOrder(page, ['A', 'B', 'C']);
    });
  });

  test('S-5 [AC-4] 브라우저 시간대가 UTC면 "회의록 공유" 줄에 생성일 2026-11-17이 보이고 시각은 보이지 않는다', async ({ page }) => {
    await withServer([A1], async (baseURL) => {
      await page.goto(`${baseURL}/`);
      const r = row(page, '회의록 공유');
      await expect(r.getByText('2026-11-17', { exact: true })).toBeVisible();
      await expect(r).not.toContainText('06:10');
      await expect(r).not.toContainText('생성일');
    });
  });

  test('S-6 [AC-4] 생성일은 브라우저 시간대 기준 날짜다(Asia/Seoul이면 UTC 2026-11-16T20:00Z가 2026-11-17)', async ({ browser }) => {
    await withServer([task('k1', '회의록 공유', '2026-11-16T20:00:00Z')], async (baseURL) => {
      const context = await browser.newContext({ timezoneId: 'Asia/Seoul' });
      try {
        const page = await context.newPage();
        await page.goto(`${baseURL}/`);
        const r = row(page, '회의록 공유');
        await expect(r.getByText('2026-11-17', { exact: true })).toBeVisible();
        await expect(r).not.toContainText('2026-11-16');
      } finally {
        await context.close();
      }
    });
  });

  test('S-7 [AC-5, AC-6] 완료된 "회의록 공유" 줄에는 체크 아이콘과 "완료" 글자가 보이고 완료 버튼이 없다', async ({ page, request }) => {
    await withServer([A1], async (baseURL) => {
      await completeViaApi(request, baseURL, 'a1');
      await page.goto(`${baseURL}/`);
      await expect(items(page)).toHaveCount(1);
      await expectDone(page, '회의록 공유');
    });
  });

  test('S-8 [AC-7] 완료되지 않은 "회의록 공유" 줄에는 글자 "완료", 이름 "회의록 공유 완료"인 버튼이 있다', async ({ page }) => {
    await withServer([A1], async (baseURL) => {
      await page.goto(`${baseURL}/`);
      await expectNotDone(page, '회의록 공유');
      await expect(row(page, '회의록 공유').getByRole('button')).toHaveCount(1);
    });
  });

  test('S-9 [AC-5, AC-6, AC-7] 완료된 줄과 미완료 줄이 섞여 있으면 줄마다 제 모습으로 보이고, 완료된 줄도 목록에 남는다', async ({ page, request }) => {
    await withServer(ABC, async (baseURL) => {
      await completeViaApi(request, baseURL, 'tc');
      await page.goto(`${baseURL}/`);
      await expectOrder(page, ['B', 'C', 'A']);
      await expectDone(page, 'C');
      await expectNotDone(page, 'B');
      await expectNotDone(page, 'A');
    });
  });
});

test.describe('UI-01 비어 있음', () => {
  test('S-10 [AC-18, AC-19] 액션 아이템이 없으면 "액션 아이템이 없습니다."만 보이고 목록 항목은 없다', async ({ page }) => {
    await withServer([], async (baseURL) => {
      await page.goto(`${baseURL}/`);
      await expect(page.getByText(TEXT.empty, { exact: true })).toBeVisible();
      await expect(page.locator('li')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: TEXT.heading, exact: true })).toBeVisible();
      await expect(page.getByText(TEXT.loading)).toHaveCount(0);
      await expect(page.getByRole('button')).toHaveCount(0);
    });
  });
});

test.describe('UI-01 불러오기 실패', () => {
  test('S-11 [AC-20] GET /tasks가 500이면 실패 안내와 "다시 시도" 버튼이 보인다', async ({ page }) => {
    await withServer([A1], async (baseURL) => {
      await page.route('**/tasks', (route) =>
        route.request().method() === 'GET' ? route.fulfill({ status: 500, json: { error: 'x' } }) : route.continue());
      await page.goto(`${baseURL}/`);
      await expect(page.getByText(TEXT.loadError, { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: TEXT.retry, exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: TEXT.heading, exact: true })).toBeVisible();
      await expect(page.locator('li')).toHaveCount(0);
      await expect(page.getByText(TEXT.empty)).toHaveCount(0);
    });
  });

  test('S-12 [AC-20] GET /tasks가 네트워크 오류로 실패해도 실패 안내와 "다시 시도" 버튼이 보인다', async ({ page }) => {
    await withServer([A1], async (baseURL) => {
      await page.route('**/tasks', (route) =>
        route.request().method() === 'GET' ? route.abort('failed') : route.continue());
      await page.goto(`${baseURL}/`);
      await expect(page.getByText(TEXT.loadError, { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: TEXT.retry, exact: true })).toBeVisible();
    });
  });

  test('S-13 [AC-21] 실패 화면에서 "다시 시도"를 누르면 GET /tasks를 다시 요청해 "회의록 공유"가 목록에 보인다', async ({ page }) => {
    await withServer([A1], async (baseURL) => {
      const requests = trackRequests(page);
      let fail = true;
      await page.route('**/tasks', (route) =>
        route.request().method() === 'GET' && fail
          ? route.fulfill({ status: 500, json: { error: 'x' } })
          : route.continue());
      await page.goto(`${baseURL}/`);
      await expect(page.getByText(TEXT.loadError, { exact: true })).toBeVisible();
      expect(requests.count('GET', '/tasks')).toBe(1);

      fail = false;
      await page.getByRole('button', { name: TEXT.retry, exact: true }).click();
      await expect(items(page).getByText('회의록 공유', { exact: true })).toBeVisible();
      expect(requests.count('GET', '/tasks')).toBe(2);
      await expect(page.getByText(TEXT.loadError)).toHaveCount(0);
      await expect(page.getByRole('button', { name: TEXT.retry })).toHaveCount(0);
    });
  });

  test('S-14 [AC-21] "다시 시도" 뒤의 응답이 []이면 비어 있음 안내로 바뀐다', async ({ page }) => {
    await withServer([], async (baseURL) => {
      let fail = true;
      await page.route('**/tasks', (route) =>
        route.request().method() === 'GET' && fail
          ? route.fulfill({ status: 503, body: 'down' })
          : route.continue());
      await page.goto(`${baseURL}/`);
      await expect(page.getByText(TEXT.loadError, { exact: true })).toBeVisible();
      fail = false;
      await page.getByRole('button', { name: TEXT.retry, exact: true }).click();
      await expect(page.getByText(TEXT.empty, { exact: true })).toBeVisible();
      await expect(page.getByText(TEXT.loadError)).toHaveCount(0);
    });
  });
});

test.describe('UI-01 불러오는 중', () => {
  // 시계를 멈춰 0.3초 경계를 정확히 넘나든다. GET /tasks의 답은 직접 풀어 줄 때까지 붙잡는다.
  const openWithHeldList = async (page, baseURL) => {
    const release = gate();
    const requested = gate();
    await page.route('**/tasks', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      requested.open();
      await release.opened;
      return route.continue();
    });
    await page.clock.install({ time: new Date('2026-11-17T09:00:00Z') });
    await page.clock.pauseAt(new Date('2026-11-17T09:00:01Z'));
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await requested.opened;
    return release;
  };

  test('S-15 불러오는 중 (0.3초 전): 제목만 보이고 "불러오는 중입니다."는 아직 보이지 않는다', async ({ page }) => {
    await withServer([A1], async (baseURL) => {
      const release = await openWithHeldList(page, baseURL);
      await expect(page.getByRole('heading', { name: TEXT.heading, exact: true })).toBeVisible();
      await expect(page.getByText(TEXT.loading)).toHaveCount(0);
      await page.clock.runFor(250);
      await expect(page.getByText(TEXT.loading)).toHaveCount(0);
      await expect(page.locator('li')).toHaveCount(0);
      release.open();
    });
  });

  test('S-16 불러오는 중: 0.3초가 지나도 답이 없으면 제목 아래에 "불러오는 중입니다."가 보이고, 답이 오면 목록으로 바뀐다', async ({ page }) => {
    await withServer([A1], async (baseURL) => {
      const release = await openWithHeldList(page, baseURL);
      await page.clock.runFor(350);
      await expect(page.getByText(TEXT.loading, { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: TEXT.heading, exact: true })).toBeVisible();
      await expect(page.locator('li')).toHaveCount(0);

      release.open();
      await expect(items(page).getByText('회의록 공유', { exact: true })).toBeVisible();
      await expect(page.getByText(TEXT.loading)).toHaveCount(0);
    });
  });
});
