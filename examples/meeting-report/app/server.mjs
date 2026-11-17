import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 화면 파일(HTML, CSS, JavaScript)을 두는 곳. 빌드 단계 없이 그대로 내준다.
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

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

// API 라우트를 찾아 처리한다. 맞는 라우트가 없으면 undefined.
const dispatch = (store, method, pathname) =>
  routes
    .filter((route) => route.method === method)
    .map((route) => ({ route, match: route.pattern.exec(pathname) }))
    .filter(({ match }) => match)
    .map(({ route, match }) => {
      const params = match.slice(1).map(decodeSegment);
      return params.includes(undefined) ? notFound : route.handle(store, ...params);
    })
    .at(0);

// 요청 경로를 web/ 안의 파일 경로로 바꾼다. `/`는 index.html. web/ 밖을 가리키면 undefined.
const toWebFile = (pathname) => {
  const decoded = decodeSegment(pathname);
  if (decoded === undefined || decoded.includes('\0')) return undefined;
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const file = path.resolve(webRoot, relative);
  return file.startsWith(webRoot) ? file : undefined;
};

// web/의 파일을 읽어 { status, type, content }로 돌려준다. 없으면 undefined.
const readWebFile = async (pathname) => {
  const file = toWebFile(pathname);
  if (!file) return undefined;
  try {
    const content = await readFile(file);
    const type = contentTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    return { status: 200, type, content };
  } catch {
    return undefined;
  }
};

const sendFile = (res, { status, type, content }) => {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': content.length });
  res.end(content);
};

const handleRequest = async (store, req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const api = dispatch(store, req.method, pathname);
  if (api) return sendJson(res, api.status, api.body);
  const file = req.method === 'GET' ? await readWebFile(pathname) : undefined;
  return file ? sendFile(res, file) : sendJson(res, notFound.status, notFound.body);
};

/**
 * 아직 listen하지 않은 http.Server를 돌려준다.
 * options.tasks: 처음 데이터({ id, title, createdAt, completed? }의 배열. completed를 생략하면 false). 생략하면 비어 있다.
 */
export const createServer = (options = {}) => {
  // 데이터는 서버 프로세스의 메모리에 둔다.
  const store = { tasks: (options.tasks ?? []).map(toTask) };

  return http.createServer((req, res) => {
    handleRequest(store, req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal Server Error' });
      else res.end();
    });
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`listening on http://localhost:${port}`);
  });
}
