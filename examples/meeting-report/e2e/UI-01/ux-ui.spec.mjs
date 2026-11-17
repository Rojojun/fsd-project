import { test, expect } from '@playwright/test';
import {
  withServer, task, completeViaApi, gate,
  items, row, completeButton, expectOrder, expectDone, expectNotDone, TEXT,
} from './helpers.mjs';

test.use({ timezoneId: 'UTC' });

const BCA = [
  task('ta', 'A', '2026-11-15T00:00:00Z'),
  task('tb', 'B', '2026-11-17T00:00:00Z'),
  task('tc', 'C', '2026-11-16T00:00:00Z'),
];

const LONG_TITLE = '분기 회의에서 나온 예산 재검토 요청 사항을 정리하여 관련 부서 담당자 모두에게 공유하고 회신을 받아 다음 회의 전까지 취합하기';

const focusedName = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el ? (el.getAttribute('aria-label') ?? el.textContent.trim()) : null;
  });

// 요소의 글자색과, 그 요소 뒤에 실제로 칠해진 바탕색의 대비.
const contrastOf = (locator) =>
  locator.evaluate((el) => {
    const parse = (c) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const backgroundOf = (node) => {
      for (let n = node; n; n = n.parentElement) {
        const [r, g, b, a = 1] = parse(getComputedStyle(n).backgroundColor);
        if (a > 0) return [r, g, b];
      }
      return [255, 255, 255];
    };
    const lum = ([r, g, b]) => {
      const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fg = parse(getComputedStyle(el).color).slice(0, 3);
    const [l1, l2] = [lum(fg), lum(backgroundOf(el))].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  });

test.describe('UI-01 UX 기준', () => {
  test('S-28 [UX] 키보드만으로: Tab은 화면 순서대로 완료 버튼을 지나고, Enter/Space로 완료하면 초점이 다음 완료 버튼으로, 마지막엔 목록으로 옮긴다', async ({ page }) => {
    await withServer(BCA, async (baseURL) => {
      await page.goto(`${baseURL}/`);
      await expectOrder(page, ['B', 'C', 'A']);

      await page.keyboard.press('Tab');
      expect(await focusedName(page)).toBe('B 완료');
      await page.keyboard.press('Tab');
      expect(await focusedName(page)).toBe('C 완료');
      await page.keyboard.press('Tab');
      expect(await focusedName(page)).toBe('A 완료');
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(completeButton(page, 'B')).toBeFocused();

      await page.keyboard.press('Enter');
      await expectDone(page, 'B');
      await expect(completeButton(page, 'C'), 'B를 완료하면 초점은 C 버튼으로').toBeFocused();

      await page.keyboard.press('Space');
      await expectDone(page, 'C');
      await expect(completeButton(page, 'A'), 'C를 완료하면 초점은 A 버튼으로').toBeFocused();

      await page.keyboard.press('Enter');
      await expectDone(page, 'A');
      await expect(page.locator('ul'), '다음 버튼이 없으면 초점은 목록으로').toBeFocused();
    });
  });

  test('S-29 [UX] 이미 완료된 줄을 건너 초점이 다음 완료 버튼으로 옮겨 간다', async ({ page, request }) => {
    await withServer(BCA, async (baseURL) => {
      await completeViaApi(request, baseURL, 'tc');
      await page.goto(`${baseURL}/`);
      await completeButton(page, 'B').focus();
      await page.keyboard.press('Enter');
      await expectDone(page, 'B');
      await expect(completeButton(page, 'A')).toBeFocused();
    });
  });

  test('S-30 [UX] 불러오기 실패 화면의 "다시 시도"도 키보드(Tab, Enter)로 누를 수 있다', async ({ page }) => {
    await withServer([task('a1', '회의록 공유', '2026-11-17T06:10:16Z')], async (baseURL) => {
      let fail = true;
      await page.route('**/tasks', (route) =>
        route.request().method() === 'GET' && fail ? route.fulfill({ status: 500, body: 'x' }) : route.continue());
      await page.goto(`${baseURL}/`);
      await expect(page.getByText(TEXT.loadError, { exact: true })).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: TEXT.retry, exact: true })).toBeFocused();
      fail = false;
      await page.keyboard.press('Enter');
      await expect(items(page).getByText('회의록 공유', { exact: true })).toBeVisible();
    });
  });

  test('S-31 [UX] 키보드 초점이 온 버튼에는 초점 테두리(2px, 바깥 2px)가 보인다', async ({ page }) => {
    await withServer(BCA, async (baseURL) => {
      await page.goto(`${baseURL}/`);
      await expectOrder(page, ['B', 'C', 'A']);
      await page.keyboard.press('Tab');
      const button = completeButton(page, 'B');
      await expect(button).toBeFocused();
      const outline = await button.evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset };
      });
      expect(outline.style).not.toBe('none');
      expect(outline.width).toBe('2px');
      expect(outline.offset).toBe('2px');
    });
  });

  test('S-32 [UX] 완료 버튼과 "다시 시도" 버튼은 가로세로 36px 이상이다', async ({ page }) => {
    await withServer(BCA, async (baseURL) => {
      await page.goto(`${baseURL}/`);
      const box = await completeButton(page, 'B').boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(36);
      expect(box.height).toBeGreaterThanOrEqual(36);

      await page.route('**/tasks', (route) =>
        route.request().method() === 'GET' ? route.fulfill({ status: 500, body: 'x' }) : route.continue());
      await page.reload();
      const retry = await page.getByRole('button', { name: TEXT.retry, exact: true }).boundingBox();
      expect(retry.width).toBeGreaterThanOrEqual(36);
      expect(retry.height).toBeGreaterThanOrEqual(36);
    });
  });

  test('S-33 [UX] 완료된 줄은 숨기거나 흐리게 하지 않고, 상태는 색 말고 글과 아이콘으로도 구분된다', async ({ page, request }) => {
    await withServer(BCA, async (baseURL) => {
      await completeViaApi(request, baseURL, 'tc');
      await page.goto(`${baseURL}/`);
      await expectOrder(page, ['B', 'C', 'A']);
      const opacity = await row(page, 'C').evaluate((el) => {
        let o = 1;
        for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
        return o;
      });
      expect(opacity).toBe(1);
      await expectDone(page, 'C');
    });
  });
});

test.describe('UI-01 UI 기준', () => {
  test('S-34 [UI] 문구: 제목은 "액션 아이템", 날짜 앞에 이름표가 없고, "할 일"/"태스크"/느낌표를 쓰지 않는다', async ({ page }) => {
    await withServer(BCA, async (baseURL) => {
      await page.goto(`${baseURL}/`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(TEXT.heading);
      await expectOrder(page, ['B', 'C', 'A']);
      const text = await page.locator('body').innerText();
      for (const word of ['할 일', '태스크', '!', '생성일']) expect(text).not.toContain(word);
    });
  });

  test('S-35 [UI] 완료 표시: 체크 아이콘은 약 20px, "완료" 글자는 16px 굵기 600이다', async ({ page, request }) => {
    await withServer(BCA, async (baseURL) => {
      await completeViaApi(request, baseURL, 'tc');
      await page.goto(`${baseURL}/`);
      const r = row(page, 'C');
      const label = r.getByText('완료', { exact: true });
      await expect(label).toBeVisible();
      const font = await label.evaluate((el) => ({ size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight }));
      expect(font.size).toBe('16px');
      expect(font.weight).toBe('600');
      const icon = await r.locator('svg, img').first().boundingBox();
      expect(Math.round(icon.width)).toBe(20);
      expect(Math.round(icon.height)).toBe(20);
    });
  });

  test('S-36 좁은 화면 (너비 320px): 가로로 밀리지 않고, 완료 버튼·완료 표시·실패 안내는 제목과 날짜 아래에 보이며 긴 제목은 잘리지 않는다', async ({ page, request }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await withServer([task('long', LONG_TITLE, '2026-11-17T08:00:00Z'), ...BCA], async (baseURL) => {
      await completeViaApi(request, baseURL, 'tc');
      await page.route('**/tasks/tb/complete', (route) => route.fulfill({ status: 500, body: 'x' }));
      await page.goto(`${baseURL}/`);
      await expectOrder(page, [LONG_TITLE, 'B', 'C', 'A']);
      await completeButton(page, 'B').click();
      await expect(page.getByText(TEXT.completeError, { exact: true })).toBeVisible();

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, '가로 스크롤이 생기지 않는다').toBeLessThanOrEqual(0);

      // 긴 제목은 말줄임으로 자르지 않고 줄을 바꾼다.
      const title = row(page, LONG_TITLE).getByText(LONG_TITLE, { exact: true });
      const clipped = await title.evaluate((el) => el.scrollWidth > el.clientWidth || getComputedStyle(el).textOverflow === 'ellipsis');
      expect(clipped).toBe(false);
      expect((await title.boundingBox()).height).toBeGreaterThan(30);

      // 버튼과 완료 표시는 날짜 아래로 내려온다.
      const below = async (titleText, control) => {
        const date = await row(page, titleText).getByText(/^\d{4}-\d{2}-\d{2}$/).boundingBox();
        const box = await control.boundingBox();
        expect(box.y, `${titleText} 줄의 버튼/표시는 날짜 아래`).toBeGreaterThanOrEqual(date.y + date.height);
        expect(box.x + box.width).toBeLessThanOrEqual(320);
      };
      await below(LONG_TITLE, completeButton(page, LONG_TITLE));
      await below('B', completeButton(page, 'B'));
      await below('C', row(page, 'C').getByText('완료', { exact: true }));
    });
  });

  test('S-37 [UI] 어두운 화면에서 제목, 날짜, 완료 표시, 버튼 글자, 실패 안내가 4.5:1 이상으로 읽힌다', async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await withServer(BCA, async (baseURL) => {
      await completeViaApi(request, baseURL, 'tc');
      await page.route('**/tasks/tb/complete', (route) => route.fulfill({ status: 500, body: 'x' }));
      await page.goto(`${baseURL}/`);
      await completeButton(page, 'B').click();
      const error = page.getByText(TEXT.completeError, { exact: true });
      await expect(error).toBeVisible();

      const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bodyBg, '어두운 화면은 어두운 바탕').not.toBe('rgb(255, 255, 255)');

      const targets = {
        heading: page.getByRole('heading', { level: 1 }),
        title: row(page, 'A').getByText('A', { exact: true }),
        date: row(page, 'A').getByText('2026-11-15', { exact: true }),
        done: row(page, 'C').getByText('완료', { exact: true }),
        button: completeButton(page, 'A'),
        error,
      };
      for (const [name, locator] of Object.entries(targets)) {
        expect(await contrastOf(locator), `${name} 대비`).toBeGreaterThanOrEqual(4.5);
      }
    });
  });

  test('S-38 [UI] 밝은 화면에서도 같은 요소가 4.5:1 이상으로 읽힌다', async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await withServer(BCA, async (baseURL) => {
      await completeViaApi(request, baseURL, 'tc');
      await page.goto(`${baseURL}/`);
      const targets = {
        heading: page.getByRole('heading', { level: 1 }),
        title: row(page, 'A').getByText('A', { exact: true }),
        date: row(page, 'A').getByText('2026-11-15', { exact: true }),
        done: row(page, 'C').getByText('완료', { exact: true }),
        button: completeButton(page, 'A'),
      };
      for (const [name, locator] of Object.entries(targets)) {
        await expect(locator).toBeVisible();
        expect(await contrastOf(locator), `${name} 대비`).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
});
