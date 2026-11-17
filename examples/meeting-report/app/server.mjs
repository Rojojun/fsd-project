import http from 'node:http';
import { pathToFileURL } from 'node:url';

// 생성일을 ISO 8601 UTC 문자열로 맞춘다. 밀리초가 0이면 초 단위까지만 쓴다(예: 2026-11-17T06:10:16Z).
const toUtcString = (value) => new Date(value).toISOString().replace('.000Z', 'Z');

const toTask = ({ id, title, createdAt, completed }) => ({
  id: String(id),
  title: String(title),
  createdAt: toUtcString(createdAt),
  completed: completed === true,
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

const notFound = { status: 404, body: { error: 'Not Found' } };

// 해당 액션 아이템을 완료로 표시한다. 이미 완료되어 있어도 같은 응답을 돌려준다.
const completeTask = (store, id) => {
  const found = store.tasks.find((task) => task.id === id);
  if (!found) return notFound;
  const completed = { ...found, completed: true };
  store.tasks = store.tasks.map((task) => (task.id === id ? completed : task));
  return { status: 200, body: completed };
};

// 경로 조각을 디코딩한다. 잘못된 인코딩이면 undefined.
const decodeSegment = (segment) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

// 각 라우트: 메서드, 경로 패턴, 핸들러((store, ...경로 매개변수) => ({ status, body })).
const routes = [
  { method: 'GET', pattern: /^\/tasks$/, handle: (store) => ({ status: 200, body: listTasks(store.tasks) }) },
  { method: 'POST', pattern: /^\/tasks\/([^/]+)\/complete$/, handle: completeTask },
];

const dispatch = (store, method, pathname) =>
  routes
    .filter((route) => route.method === method)
    .map((route) => ({ route, match: route.pattern.exec(pathname) }))
    .filter(({ match }) => match)
    .map(({ route, match }) => {
      const params = match.slice(1).map(decodeSegment);
      return params.includes(undefined) ? notFound : route.handle(store, ...params);
    })
    .at(0) ?? notFound;

/**
 * 아직 listen하지 않은 http.Server를 돌려준다.
 * options.tasks: 처음 데이터({ id, title, createdAt, completed? }의 배열. completed를 생략하면 false). 생략하면 비어 있다.
 */
export const createServer = (options = {}) => {
  // 데이터는 서버 프로세스의 메모리에 둔다.
  const store = { tasks: (options.tasks ?? []).map(toTask) };

  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const { status, body } = dispatch(store, req.method, pathname);
    return sendJson(res, status, body);
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`listening on http://localhost:${port}`);
  });
}
