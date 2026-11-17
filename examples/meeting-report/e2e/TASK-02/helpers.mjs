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

// POST /tasks/{id}/complete를 본문 없이 실제 HTTP로 요청한다. 본문은 글자 그대로 돌려준다(404 본문은 정해져 있지 않다).
export const completeTask = async (request, baseURL, id) => {
  const response = await request.post(`${baseURL}/tasks/${encodeURIComponent(id)}/complete`);
  return { status: response.status(), text: await response.text() };
};

// 목록에서 id가 같은 요소를 찾는다.
export const findById = (tasks, id) => tasks.find((task) => task.id === id);
