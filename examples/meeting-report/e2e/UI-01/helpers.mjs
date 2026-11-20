import { expect } from '@playwright/test';
import { createServer } from '../../app/server.mjs';

// 주어진 액션 아이템으로 서버를 빈 포트에 띄우고, fn이 끝나면 닫는다.
export const withServer = async (tasks, fn) => {
  const server = tasks === undefined ? createServer() : createServer({ tasks });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(baseURL);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
};

// 완료되지 않은 액션 아이템 하나. 완료된 상태는 실제 POST 요청으로 만든다(스펙에 없는 시드 옵션을 쓰지 않는다).
export const task = (id, title, createdAt) => ({ id, title, createdAt });

// 실제 HTTP 요청으로 완료 처리한다.
export const completeViaApi = async (request, baseURL, id) => {
  const response = await request.post(`${baseURL}/tasks/${encodeURIComponent(id)}/complete`);
  expect(response.status(), `준비: ${id} 완료 처리`).toBe(200);
};

// 실제 HTTP 요청으로 목록을 읽는다.
export const getTasksViaApi = async (request, baseURL) => {
  const response = await request.get(`${baseURL}/tasks`);
  expect(response.status()).toBe(200);
  return response.json();
};

// 화면이 보낸 요청을 센다. path는 '/tasks'나 '/tasks/a1/complete'.
export const trackRequests = (page) => {
  const seen = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    seen.push({ method: req.method(), path: url.pathname });
  });
  return {
    count: (method, path) => seen.filter((r) => r.method === method && r.path === path).length,
    ofMethod: (method) => seen.filter((r) => r.method === method),
  };
};

// 직접 풀어 줄 때까지 기다리는 문.
export const gate = () => {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { opened, open };
};

// 화면의 목록 항목들.
export const items = (page) => page.locator('ul > li');

// 제목이 정확히 title인 목록 항목(줄).
export const row = (page, title) =>
  items(page).filter({ has: page.getByText(title, { exact: true }) });

// 그 줄의 완료 버튼(화면 낭독기 이름 "<제목> 완료").
export const completeButton = (page, title) =>
  row(page, title).getByRole('button', { name: `${title} 완료`, exact: true });

// 목록 항목의 제목이 위에서부터 titles 차례인지 확인한다.
export const expectOrder = async (page, titles) => {
  await expect(items(page)).toHaveCount(titles.length);
  for (const [i, title] of titles.entries()) {
    await expect(items(page).nth(i).getByText(title, { exact: true }), `${i + 1}번째 줄은 ${title}`).toBeVisible();
  }
};

// 완료 표시: "완료" 글자 + 아이콘, 완료 버튼 없음.
export const expectDone = async (page, title) => {
  const r = row(page, title);
  await expect(r.getByRole('button')).toHaveCount(0);
  await expect(r.getByText('완료', { exact: true })).toBeVisible();
  await expect(r.locator('svg, img').first(), '체크 아이콘').toBeVisible();
};

// 아직 완료되지 않은 줄: "완료" 글자의 누를 수 있는 완료 버튼이 있다.
export const expectNotDone = async (page, title) => {
  const button = completeButton(page, title);
  await expect(button).toBeVisible();
  await expect(button).toHaveText('완료');
  await expect(button).toBeEnabled();
};

export const TEXT = {
  heading: '액션 아이템',
  loading: '불러오는 중입니다.',
  empty: '액션 아이템이 없습니다.',
  loadError: '액션 아이템을 불러오지 못했습니다.',
  retry: '다시 시도',
  completeError: '완료 처리에 실패했습니다. 완료 버튼을 눌러 다시 시도해 주세요.',
  processing: '처리 중',
};
