import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const [, , appPath, order] = process.argv;
const { createHandler } = await import(pathToFileURL(appPath));
const older = { id: 'old', createdAt: '2026-11-16T00:00:00Z' };
const newer = { id: 'new', createdAt: '2026-11-17T00:00:00Z' };

async function assertTasks(input, expected) {
  const handle = createHandler(input);
  const response = await handle(new Request('http://localhost/tasks'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await response.json(), expected);
}

await assertTasks(order === 'desc' ? [older, newer] : [newer, older],
  order === 'desc' ? [newer, older] : [older, newer]);
await assertTasks([], []);
