import http from 'node:http';
import { pathToFileURL } from 'node:url';

// 생성일을 ISO 8601 UTC 문자열로 맞춘다. 밀리초가 0이면 초 단위까지만 쓴다(예: 2026-11-17T06:10:16Z).
const toUtcString = (value) => new Date(value).toISOString().replace('.000Z', 'Z');

const toTask = ({ id, title, createdAt }) => ({
  id: String(id),
  title: String(title),
  createdAt: toUtcString(createdAt),
});

// 생성일이 최신인 것부터(내림차순).
const byNewestFirst = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

const listTasks = (tasks) => tasks.toSorted(byNewestFirst);

const sendJson = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const routes = {
  'GET /tasks': (store) => ({ status: 200, body: listTasks(store.tasks) }),
};

/**
 * 아직 listen하지 않은 http.Server를 돌려준다.
 * options.tasks: 처음 데이터({ id, title, createdAt }의 배열). 생략하면 비어 있다.
 */
export const createServer = (options = {}) => {
  // 데이터는 서버 프로세스의 메모리에 둔다.
  const store = { tasks: (options.tasks ?? []).map(toTask) };

  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const route = routes[`${req.method} ${pathname}`];
    if (!route) return sendJson(res, 404, { error: 'Not Found' });
    const { status, body } = route(store);
    return sendJson(res, status, body);
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`listening on http://localhost:${port}`);
  });
}
