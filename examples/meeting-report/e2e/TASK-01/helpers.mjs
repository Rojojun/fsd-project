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
    await new Promise((resolve) => server.close(resolve));
  }
};

// GET /tasks를 실제 HTTP로 요청하고 상태 코드와 (JSON으로 읽은) 본문을 돌려준다.
export const getTasks = async (request, baseURL) => {
  const response = await request.get(`${baseURL}/tasks`);
  const text = await response.text();
  return { status: response.status(), text, body: JSON.parse(text) };
};

// ISO 8601 UTC 형식(예: 2026-11-17T06:10:16Z). 소수 초는 있어도 된다.
export const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
