import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/init.ts';
import { discoverLinear, pullLinear } from '../src/sources/linear.ts';
import type { Agent, AgentResult, AgentTask } from '../src/agents/types.ts';
import type { LinearScopes } from '../src/sources/linear.ts';

const root = () => mkdtempSync(join(tmpdir(), 'agdd-init-'));
const configOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'agdd.config.json'), 'utf8'));
/** 정해진 답을 차례로 주고, 받은 질문을 기록한다 */
const answers = (...list: string[]) => {
  const asked: string[] = [];
  const ask = async (question: string) => {
    asked.push(question);
    return list.shift() ?? '';
  };
  return { ask, asked };
};
const scopes: LinearScopes = {
  projects: [
    { name: '사내 위키', team: '플랫폼', ready: 2 },
    { name: '회의 보고', team: '제품', ready: 7 },
    { name: '끝난 일', team: '제품', ready: 0 },
  ],
  teams: [{ name: '제품', ready: 12 }, { name: '플랫폼', ready: 2 }],
};
const found = async () => ({ ok: true as const, scopes });
const lines: string[] = [];
const log = (line: string) => void lines.push(line);

test('처음에 Linear를 쓸지 묻는다', async () => {
  const { ask, asked } = answers('n');
  await runInit({ root: root(), ask, discover: found, log });
  assert.match(asked[0], /Linear/);
  assert.equal(asked.length, 1);
});

test('쓰지 않는다고 하면 Linear를 살펴보지 않고, 파일로 쓴다는 것을 설정에 남긴다', async () => {
  const dir = root();
  let discovered = false;
  const r = await runInit({ root: dir, ask: answers('').ask, log, discover: async () => { discovered = true; return found(); } });
  assert.equal(discovered, false);
  assert.equal(configOf(dir).source.linear, null);
  assert.equal(r.linear, null);
});

test('쓴다고 하면 후보를 진행할 이슈가 많은 순으로 보여 주고, 고른 범위를 설정에 남긴다', async () => {
  const dir = root();
  const shown: string[] = [];
  const { ask, asked } = answers('y', '1');
  const r = await runInit({ root: dir, ask, discover: found, log: l => void shown.push(l) });
  const list = shown.join('\n');
  assert.ok(list.indexOf('회의 보고') < list.indexOf('사내 위키'), '진행할 이슈가 많은 프로젝트가 먼저');
  assert.match(list, /회의 보고.*7/);
  assert.match(asked[1], /번호/);
  assert.deepEqual(configOf(dir).source.linear, { project: '회의 보고', stateTypes: ['unstarted', 'started'] });
  assert.deepEqual(r.linear, { project: '회의 보고', stateTypes: ['unstarted', 'started'] });
});

test('번호를 적지 않으면 추천(첫 번째)을 고른다', async () => {
  const dir = root();
  await runInit({ root: dir, ask: answers('y', '').ask, discover: found, log });
  assert.equal(configOf(dir).source.linear.project, '회의 보고');
});

test('프로젝트 대신 팀 전체를 고를 수 있다', async () => {
  const dir = root();
  const shown: string[] = [];
  await runInit({ root: dir, ask: answers('y', '4').ask, discover: found, log: l => void shown.push(l) });
  // 후보: 프로젝트 셋(1~3) 다음에 팀 둘(4~5)
  assert.deepEqual(configOf(dir).source.linear, { team: '제품', stateTypes: ['unstarted', 'started'] });
});

test('없는 번호면 다시 묻고, 계속 틀리면 아무것도 바꾸지 않는다', async () => {
  const dir = root();
  const { ask, asked } = answers('y', '99', 'abc', '0');
  const r = await runInit({ root: dir, ask, discover: found, log });
  assert.equal(asked.length, 4);
  assert.equal(r.linear, undefined);
  assert.equal(existsSync(join(dir, 'agdd.config.json')), false);
});

test('Linear가 연결되어 있지 않으면 이유를 알리고 파일로 쓰는 설정을 남긴다', async () => {
  const dir = root();
  const shown: string[] = [];
  await runInit({ root: dir, ask: answers('y').ask, log: l => void shown.push(l), discover: async () => ({ ok: false as const, message: 'Linear MCP 서버가 연결되어 있지 않습니다.' }) });
  assert.match(shown.join('\n'), /연결되어 있지 않습니다/);
  assert.equal(configOf(dir).source.linear, null);
});

test('이미 있는 설정의 다른 항목은 그대로 둔다', async () => {
  const dir = root();
  writeFileSync(join(dir, 'agdd.config.json'), JSON.stringify({ verify: { command: 'npm run e2e' }, source: { linear: { team: '옛 팀' } } }));
  await runInit({ root: dir, ask: answers('y', '1').ask, discover: found, log });
  assert.equal(configOf(dir).verify.command, 'npm run e2e');
  assert.equal(configOf(dir).source.linear.project, '회의 보고');
});

test('답을 미리 주면 묻지 않는다', async () => {
  const dir = root();
  const { ask, asked } = answers();
  await runInit({ root: dir, ask, discover: found, log, preset: { useLinear: true, project: '사내 위키' } });
  assert.equal(asked.length, 0);
  assert.equal(configOf(dir).source.linear.project, '사내 위키');

  await runInit({ root: dir, ask, discover: found, log, preset: { useLinear: false } });
  assert.equal(configOf(dir).source.linear, null);
});

// ── Linear 살펴보기, 기본 범위 ──

const usage = { costUsd: 0.01, inputTokens: 10, outputTokens: 5, turns: 2, durationMs: 100 };
const fakeAgent = (output: unknown) => {
  const tasks: AgentTask[] = [];
  const agent: Agent = async task => {
    tasks.push(task);
    return { agent: 'fake', model: 'm', usage, ok: true, output } as AgentResult;
  };
  return { agent, tasks };
};
const common = { server: 'linear', settings: { timeoutMs: 5000, maxTurns: 9 } };

test('살펴보기: Linear를 읽기만 하는 과제로 프로젝트와 팀의 후보를 받는다', async () => {
  const { agent, tasks } = fakeAgent(scopes);
  const r = await discoverLinear({ ...common, root: root(), agent, skill: 'SCOUT-RULES' });
  assert.ok(r.ok);
  assert.equal(r.scopes.projects.length, 3);
  assert.deepEqual([tasks[0].access, tasks[0].mcp], ['read-only', ['linear']]);
  assert.ok(tasks[0].prompt.includes('SCOUT-RULES'));
});

test('살펴보기: 형식이 다르면 실패로 돌려준다', async () => {
  const r = await discoverLinear({ ...common, root: root(), agent: fakeAgent({ projects: 'x' }).agent, skill: 's' });
  assert.ok(!r.ok);
});

test('가져오기: 상태를 따로 정하지 않으면 시작 전과 진행 중인 이슈만 가져오게 한다', async () => {
  const { agent, tasks } = fakeAgent({ issues: [] });
  await pullLinear({ ...common, root: root(), agent, skill: 's', filter: { project: '회의 보고' }, dryRun: true });
  assert.match(tasks[0].prompt, /unstarted.*started/s);
  assert.doesNotMatch(tasks[0].prompt, /backlog.*가져온다/);
});
