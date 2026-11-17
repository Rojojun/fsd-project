import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRequirement } from '../src/catalog.ts';
import { pullLinear, toRequirementFile } from '../src/sources/linear.ts';
import type { Agent, AgentResult, AgentTask } from '../src/agents/types.ts';

const issue = (over: object = {}) => ({
  identifier: 'ENG-12', title: '액션 아이템 목록 조회', priority: 2, stateType: 'unstarted',
  labels: ['backend'], blockedBy: [] as string[], url: 'https://linear.app/x/issue/ENG-12',
  description: '목록을 조회한다.\n\n- `GET /tasks`는 JSON 배열을 돌려준다.', ...over,
});
const parsed = (i: ReturnType<typeof issue>, known = ['ENG-12']) => {
  const file = toRequirementFile(i, new Set(known));
  const r = parseRequirement(file.name, file.text);
  assert.ok(r.ok, r.ok ? '' : r.errors.join());
  return r.doc;
};

test('Linear 이슈는 요구사항 파일이 된다: 식별자가 ID, 본문은 설명 그대로', () => {
  const doc = parsed(issue());
  assert.equal(doc.id, 'ENG-12');
  assert.equal(doc.title, '액션 아이템 목록 조회');
  assert.equal(doc.body, '목록을 조회한다.\n\n- `GET /tasks`는 JSON 배열을 돌려준다.');
  assert.equal(toRequirementFile(issue(), new Set()).name, 'ENG-12.md');
});

test('우선순위: 긴급·높음은 P0, 보통은 P1, 낮음·없음은 P2', () => {
  assert.deepEqual([1, 2, 3, 4, 0].map(priority => parsed(issue({ priority })).priority), ['P0', 'P0', 'P1', 'P2', 'P2']);
});

test('선행 관계: 함께 가져온 이슈가 막고 있을 때만 depends가 된다', () => {
  const doc = parsed(issue({ blockedBy: ['ENG-10', 'OPS-3'] }), ['ENG-12', 'ENG-10']);
  assert.deepEqual(doc.depends, ['ENG-10']);
});

test('라벨: policy:<ID>는 근거 정책, design과 no-design은 디자인 필요 여부', () => {
  assert.deepEqual(parsed(issue({ labels: ['policy:newest-first', 'backend'] })).policies, ['newest-first']);
  assert.equal(parsed(issue({ labels: ['design'] })).design, true);
  assert.equal(parsed(issue({ labels: ['no-design'] })).design, false);
  assert.equal(parsed(issue()).design, null);
});

test('취소된 이슈는 폐기로 표시한다', () => {
  assert.equal(parsed(issue({ stateType: 'canceled' })).deprecated, true);
  assert.equal(parsed(issue()).deprecated, false);
});

test('제목에 따옴표나 콜론이 있어도 그대로 옮긴다', () => {
  assert.equal(parsed(issue({ title: '목록: "최신순" 정렬 #1' })).title, '목록: "최신순" 정렬 #1');
});

test('같은 이슈는 언제 가져와도 같은 파일이 된다 (지문이 바뀌지 않는다)', () => {
  assert.equal(toRequirementFile(issue(), new Set()).text, toRequirementFile(issue(), new Set()).text);
});

// ── pull ──

const usage = { costUsd: 0.1, inputTokens: 10, outputTokens: 5, turns: 2, durationMs: 100 };
const fakeAgent = (reply: { output: unknown } | { reason: 'timeout'; detail: string }) => {
  const tasks: AgentTask[] = [];
  const agent: Agent = async task => {
    tasks.push(task);
    const base = { agent: 'fake', model: 'm', usage };
    return ('output' in reply ? { ...base, ok: true, ...reply } : { ...base, ok: false, ...reply }) as AgentResult;
  };
  return { agent, tasks };
};
const setup = () => ({
  root: mkdtempSync(join(tmpdir(), 'fsd-linear-')),
  server: 'linear',
  settings: { timeoutMs: 5000, maxTurns: 9 },
  skill: 'READER-RULES',
  filter: { project: '회의 보고', states: ['Todo', 'In Progress'] },
  dryRun: false,
});
const fileOf = (root: string, id: string) => join(root, 'requirements', `${id}.md`);

test('pull: 가져온 이슈를 요구사항 파일로 쓰고, 무엇이 새로 생기고 바뀌었는지 알려 준다', async () => {
  const input = setup();
  const first = await pullLinear({ ...input, agent: fakeAgent({ output: { issues: [issue(), issue({ identifier: 'ENG-13', title: '완료 처리', blockedBy: ['ENG-12'] })] } }).agent });
  assert.ok(first.ok);
  assert.deepEqual([first.created, first.changed, first.unchanged], [['ENG-12', 'ENG-13'], [], []]);
  assert.match(readFileSync(fileOf(input.root, 'ENG-13'), 'utf8'), /depends:\s*\n?\s*-? ?\[?ENG-12/);

  const second = await pullLinear({ ...input, agent: fakeAgent({ output: { issues: [issue(), issue({ identifier: 'ENG-13', title: '완료 처리(수정)', blockedBy: ['ENG-12'] })] } }).agent });
  assert.ok(second.ok);
  assert.deepEqual([second.created, second.changed, second.unchanged], [[], ['ENG-13'], ['ENG-12']]);
});

test('pull: 과제는 Linear 서버만 쓰는 읽기 전용이고, 가져올 범위와 규칙을 담는다', async () => {
  const { agent, tasks } = fakeAgent({ output: { issues: [issue()] } });
  await pullLinear({ ...setup(), agent });
  assert.equal(tasks[0].access, 'read-only');
  assert.deepEqual(tasks[0].mcp, ['linear']);
  for (const piece of ['READER-RULES', '회의 보고', 'Todo', 'In Progress']) assert.ok(tasks[0].prompt.includes(piece), piece);
});

test('pull: 이번에 오지 않은 이슈의 파일은 지우지 않는다', async () => {
  const input = setup();
  await pullLinear({ ...input, agent: fakeAgent({ output: { issues: [issue(), issue({ identifier: 'ENG-13' })] } }).agent });
  const r = await pullLinear({ ...input, agent: fakeAgent({ output: { issues: [issue()] } }).agent });
  assert.ok(r.ok);
  assert.ok(existsSync(fileOf(input.root, 'ENG-13')));
  assert.deepEqual(r.missing, ['ENG-13']);
});

test('pull: 사람이 직접 쓴 요구사항 파일은 건드리지 않고, 같은 ID가 겹치면 덮어쓰지 않는다', async () => {
  const input = setup();
  mkdirSync(join(input.root, 'requirements'));
  writeFileSync(fileOf(input.root, 'ENG-12'), '---\nid: ENG-12\ntitle: 손으로 쓴 것\npriority: P1\n---\n본문\n');
  const r = await pullLinear({ ...input, agent: fakeAgent({ output: { issues: [issue()] } }).agent });
  assert.ok(r.ok);
  assert.deepEqual(r.skipped.map(s => s.id), ['ENG-12']);
  assert.match(readFileSync(fileOf(input.root, 'ENG-12'), 'utf8'), /손으로 쓴 것/);
});

test('pull: 본문이 없거나 식별자가 이상한 이슈는 건너뛰고 이유를 알려 준다', async () => {
  const input = setup();
  const r = await pullLinear({ ...input, agent: fakeAgent({ output: { issues: [issue({ description: '  ' }), issue({ identifier: '../etc' }), issue({ identifier: 'ENG-14' })] } }).agent });
  assert.ok(r.ok);
  assert.deepEqual(r.created, ['ENG-14']);
  assert.equal(r.skipped.length, 2);
  assert.match(r.skipped.map(s => s.reason).join(), /본문/);
  assert.equal(existsSync(join(input.root, 'etc.md')), false);
});

test('pull --dry-run: 파일을 쓰지 않고 무엇이 바뀔지만 알려 준다', async () => {
  const input = setup();
  const r = await pullLinear({ ...input, dryRun: true, agent: fakeAgent({ output: { issues: [issue()] } }).agent });
  assert.ok(r.ok);
  assert.deepEqual(r.created, ['ENG-12']);
  assert.equal(existsSync(fileOf(input.root, 'ENG-12')), false);
});

test('pull: 에이전트가 실패하거나 형식이 다르면 아무 파일도 쓰지 않는다', async () => {
  const input = setup();
  const failed = await pullLinear({ ...input, agent: fakeAgent({ reason: 'timeout', detail: '초과' }).agent });
  assert.ok(!failed.ok);
  const broken = await pullLinear({ ...input, agent: fakeAgent({ output: { issues: 'none' } }).agent });
  assert.ok(!broken.ok);
  assert.equal(existsSync(join(input.root, 'requirements')), false);
});
