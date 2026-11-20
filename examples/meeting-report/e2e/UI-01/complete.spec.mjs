import { test, expect } from '@playwright/test';
import {
  withServer, task, getTasksViaApi, trackRequests, gate,
  items, row, completeButton, expectOrder, expectDone, expectNotDone, TEXT,
} from './helpers.mjs';

test.use({ timezoneId: 'UTC' });

const A1 = task('a1', '회의록 공유', '2026-11-17T06:10:16Z');
const BCA = [
  task('ta', 'A', '2026-11-15T00:00:00Z'),
  task('tb', 'B', '2026-11-17T00:00:00Z'),
  task('tc', 'C', '2026-11-16T00:00:00Z'),
];

// POST /tasks/{id}/complete를 붙잡아 두고, 풀어 줄 때 어떻게 답할지 정한다.
const holdComplete = async (page) => {
  const holds = [];
  await page.route('**/tasks/*/complete', async (route) => {
    const g = gate();
    holds.push(g);
    const respond = await g.opened;
    return respond(route);
  });
  return {
    pending: () => holds.length,
    // n번째(0부터) 요청에 답한다. respond는 route를 받아 응답한다.
    answer: (n, respond = (route) => route.continue()) => holds[n].open(respond),
  };
};

test.describe('UI-01 완료 처리 성공', () => {
  test('S-17 [AC-8] "회의록 공유" 줄의 완료 버튼을 누르면 POST /tasks/a1/complete가 한 번 간다', async ({ page }) => {
    await withServer([A1], async (baseURL) => {
      const requests = trackRequests(page);
      await page.goto(`${baseURL}/`);
      await completeButton(page, '회의록 공유').click();
      await expectDone(page, '회의록 공유');
      expect(requests.count('POST', '/tasks/a1/complete')).toBe(1);
      expect(requests.ofMethod('POST')).toHaveLength(1);
    });
  });

  test('S-18 [AC-8, AC-15] 답을 기다리는 동안 버튼을 다시 눌러도 POST는 한 번만 간다', async ({ page }) => {
    await withServer([A1], async (baseURL) => {
      const requests = trackRequests(page);
      const held = await holdComplete(page);
      await page.goto(`${baseURL}/`);
      const button = completeButton(page, '회의록 공유');
      await button.click();
      await expect(button).toBeDisabled();
      await button.click({ force: true });
      await button.click({ force: true });
      await page.waitForTimeout(300);
      expect(held.pending()).toBe(1);
      held.answer(0);
      await expectDone(page, '회의록 공유');
      expect(requests.count('POST', '/tasks/a1/complete')).toBe(1);
    });
  });

  test('S-19 [AC-9, AC-10] 완료 처리 성공: 답을 받은 뒤 그 줄에 완료 표시가 보이고 완료 버튼이 없으며, 서버에도 저장된다', async ({ page, request }) => {
    await withServer([A1], async (baseURL) => {
      const requests = trackRequests(page);
      await page.goto(`${baseURL}/`);
      await completeButton(page, '회의록 공유').click();
      await expectDone(page, '회의록 공유');
      await expect(items(page)).toHaveCount(1);
      // 화면 전체를 다시 불러오지 않는다.
      expect(requests.count('GET', '/tasks')).toBe(1);
      expect(requests.count('GET', '/')).toBe(1);
      const saved = await getTasksViaApi(request, baseURL);
      expect(saved.find((t) => t.id === 'a1').completed).toBe(true);
    });
  });

  test('S-20 [AC-11] 화면에서 완료 처리한 뒤 새로 고쳐도 "회의록 공유" 줄에 완료 표시가 보인다', async ({ page }) => {
    await withServer([A1], async (baseURL) => {
      await page.goto(`${baseURL}/`);
      await completeButton(page, '회의록 공유').click();
      await expectDone(page, '회의록 공유');
      await page.reload();
      await expect(items(page)).toHaveCount(1);
      await expectDone(page, '회의록 공유');
    });
  });

  test('S-21 [AC-12] "A"를 완료한 뒤에도 "B" 줄에는 완료 버튼이 그대로 있다', async ({ page }) => {
    await withServer([task('ta', 'A', '2026-11-17T00:00:00Z'), task('tb', 'B', '2026-11-16T00:00:00Z')], async (baseURL) => {
      await page.goto(`${baseURL}/`);
      await completeButton(page, 'A').click();
      await expectDone(page, 'A');
      await expectNotDone(page, 'B');
    });
  });

  test('S-22 [AC-13, AC-12] "C"를 완료한 뒤에도 목록은 B, C, A 차례 그대로이고 B, A의 완료 버튼은 그대로다', async ({ page }) => {
    await withServer(BCA, async (baseURL) => {
      await page.goto(`${baseURL}/`);
      await expectOrder(page, ['B', 'C', 'A']);
      await completeButton(page, 'C').click();
      await expectDone(page, 'C');
      await expectOrder(page, ['B', 'C', 'A']);
      await expectNotDone(page, 'B');
      await expectNotDone(page, 'A');
    });
  });

  test('S-23 [AC-14] 완료 처리에 성공하면 aria-live="polite" 영역에 "회의록 공유를 완료했습니다."가 들어가고, 알림 창은 뜨지 않는다', async ({ page }) => {
    await withServer([A1], async (baseURL) => {
      let dialogs = 0;
      page.on('dialog', (d) => { dialogs += 1; d.dismiss(); });
      await page.goto(`${baseURL}/`);
      const live = page.locator('[aria-live="polite"]');
      await expect(live).toHaveCount(1);
      await completeButton(page, '회의록 공유').click();
      await expect(live).toHaveText('회의록 공유를 완료했습니다.');
      expect(dialogs).toBe(0);
      await expect(page.locator('[role="dialog"], [role="alertdialog"], dialog[open]')).toHaveCount(0);
    });
  });
});

test.describe('UI-01 완료 처리 중', () => {
  test('S-24 [AC-15] 답이 늦게 오면, 답을 받기 전 그 버튼은 "처리 중"이고 누를 수 없으며 다른 줄은 그대로다', async ({ page }) => {
    await withServer([A1, task('b1', 'B', '2026-11-16T00:00:00Z')], async (baseURL) => {
      const held = await holdComplete(page);
      await page.goto(`${baseURL}/`);
      const button = completeButton(page, '회의록 공유');
      await button.click();
      await expect(button).toHaveText(TEXT.processing);
      await expect(button).toBeDisabled();
      // 답을 받기 전에는 성공한 것처럼 미리 바꾸지 않는다.
      await expect(row(page, '회의록 공유').getByText('완료', { exact: true })).toHaveCount(0);
      await expectNotDone(page, 'B');
      held.answer(0);
      await expectDone(page, '회의록 공유');
    });
  });
});

test.describe('UI-01 완료 처리 실패', () => {
  const fail500 = (route) => route.fulfill({ status: 500, json: { error: 'x' } });

  test('S-25 [AC-16, AC-17] POST가 500이면 버튼이 "완료"로 누를 수 있게 돌아오고, 그 줄 아래에 실패 안내가 한 줄 보인다', async ({ page, request }) => {
    await withServer([A1, task('b1', 'B', '2026-11-16T00:00:00Z')], async (baseURL) => {
      await page.route('**/tasks/*/complete', fail500);
      await page.goto(`${baseURL}/`);
      await completeButton(page, '회의록 공유').click();

      const error = page.getByText(TEXT.completeError, { exact: true });
      await expect(error).toHaveCount(1);
      await expect(error).toBeVisible();
      await expectNotDone(page, '회의록 공유');

      // "회의록 공유" 줄 아래, 다음 줄(B)보다 위에 있다.
      const titleBox = await row(page, '회의록 공유').getByText('회의록 공유', { exact: true }).boundingBox();
      const errorBox = await error.boundingBox();
      const nextBox = await row(page, 'B').getByText('B', { exact: true }).boundingBox();
      expect(errorBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
      expect(errorBox.y + errorBox.height).toBeLessThanOrEqual(nextBox.y);

      await expectNotDone(page, 'B');
      await expect(page.locator('[aria-live="polite"]')).not.toContainText('완료했습니다');
      const saved = await getTasksViaApi(request, baseURL);
      expect(saved.find((t) => t.id === 'a1').completed).toBe(false);
    });
  });

  test('S-26 [AC-16, AC-17] POST가 네트워크 오류로 실패해도 버튼이 돌아오고 실패 안내가 보인다', async ({ page }) => {
    await withServer([A1], async (baseURL) => {
      await page.route('**/tasks/*/complete', (route) => route.abort('failed'));
      await page.goto(`${baseURL}/`);
      await completeButton(page, '회의록 공유').click();
      await expect(page.getByText(TEXT.completeError, { exact: true })).toBeVisible();
      await expectNotDone(page, '회의록 공유');
    });
  });

  test('S-27 [AC-17] 실패 안내는 같은 버튼을 다시 누르면 사라지고, 다시 실패하면 한 줄만 보이며, 성공하면 완료 표시로 바뀐다', async ({ page }) => {
    await withServer([A1], async (baseURL) => {
      const held = await holdComplete(page);
      await page.goto(`${baseURL}/`);
      const button = completeButton(page, '회의록 공유');
      const error = page.getByText(TEXT.completeError, { exact: true });

      await button.click();
      held.answer(0, fail500);
      await expect(error).toBeVisible();

      await button.click();
      await expect(button).toHaveText(TEXT.processing);
      await expect(error, '다시 누르면 안내가 사라진다').toHaveCount(0);
      held.answer(1, fail500);
      await expect(error).toHaveCount(1);
      await expectNotDone(page, '회의록 공유');

      await button.click();
      await expect(error).toHaveCount(0);
      held.answer(2);
      await expectDone(page, '회의록 공유');
      await expect(error).toHaveCount(0);
    });
  });

  test('S-39 [UX, AC-16, AC-17] 완료 실패 후 같은 버튼으로 초점을 복구해 키보드로 재시도한다', async ({ page }) => {
    await withServer([A1], async (baseURL) => {
      const requests = trackRequests(page);
      let attempts = 0;
      await page.route('**/tasks/a1/complete', (route) => {
        attempts += 1;
        return attempts === 1 ? fail500(route) : route.continue();
      });

      await page.goto(`${baseURL}/`);
      const button = completeButton(page, '회의록 공유');
      await expect(button).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(button).toBeFocused();
      await page.keyboard.press('Enter');

      const error = row(page, '회의록 공유').getByText(TEXT.completeError, { exact: true });
      await expect(error).toBeVisible();
      await expect(button).toBeFocused();
      await expect(button).toBeEnabled();
      await expect(page.locator('[aria-live="polite"]')).toHaveText(`회의록 공유: ${TEXT.completeError}`);
      expect(requests.count('POST', '/tasks/a1/complete')).toBe(1);

      await page.keyboard.press('Enter');
      await expectDone(page, '회의록 공유');
      await expect(error).toHaveCount(0);
      expect(requests.count('POST', '/tasks/a1/complete')).toBe(2);
    });
  });
});
