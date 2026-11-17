import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tickVerify } from '../src/nodes/verify.ts';
import { readQaPlan } from '../src/qa.ts';
import { specHash, writeSpec } from '../src/spec.ts';
import { apply, register } from '../src/transitions.ts';
import type { Agent, AgentResult, AgentTask, Exec, ExecResult } from '../src/agents/types.ts';
import type { RequirementDoc, RequirementState } from '../src/model.ts';

const at = '2026-11-17T00:00:00Z';
const usage = { costUsd: 0.1, inputTokens: 10, outputTokens: 5, turns: 2, durationMs: 100 };
const doc: RequirementDoc = {
  id: 'A', title: '목록', priority: 'P1', depends: [], policies: [], design: null, deprecated: false, body: '목록을 돌려준다', hash: 'req-h',
};
const spec = {
  summary: '요약', contract: '`GET /tasks` 계약', policies: [], design: { needed: false, reason: 'r' },
  acceptance: [{ id: 'AC-1', given: 'g', when: 'w', then: '빈 배열을 돌려준다' }],
};
const plan = (covers = ['AC-1']) => ({
  status: 'done', questions: [],
  plan: { summary: 'API 검사 계획', scenarios: [{ id: 'S-1', target: 'api', screen: '', covers, basis: 'acceptance', title: '빈 목록', steps: 'GET /tasks', expected: '[]', file: 'e2e/A/api.test.mjs' }] },
});
const writesTest = (task: AgentTask) => {
  mkdirSync(join(task.cwd, 'e2e', 'A'), { recursive: true });
  writeFileSync(join(task.cwd, 'e2e', 'A', 'api.test.mjs'), '// AC-1');
};
const fakeAgent = (reply: { output: unknown } | { reason: 'timeout'; detail: string }, sideEffect: (task: AgentTask) => void = () => {}) => {
  const tasks: AgentTask[] = [];
  const agent: Agent = async task => {
    tasks.push(task);
    sideEffect(task);
    const base = { agent: 'fake', model: 'm', usage };
    return ('output' in reply ? { ...base, ok: true, ...reply } : { ...base, ok: false, ...reply }) as AgentResult;
  };
  return { agent, tasks };
};
/** 테스트 명령 대신 정해진 결과를 돌려주고 호출을 기록한다 */
const fakeExec = (result: Partial<ExecResult> = {}) => {
  const calls: { command: string; args: readonly string[]; cwd: string; timeoutMs: number }[] = [];
  const exec: Exec = async (command, args, options) => {
    calls.push({ command, args, ...options });
    return { code: 0, stdout: 'ok', stderr: '', timedOut: false, ...result };
  };
  return { exec, calls };
};
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'agdd-verify-'));
  writeSpec(root, doc, spec);
  const hash = specHash(root, 'A')!;
  const specified = apply(apply(register('A', 'req-h', at), 'draftSpec', 'spec', { specHash: hash }, at), 'approveSpec', 'human', { specHash: hash }, at);
  const implemented = apply(apply(specified, 'startDev', 'dev', {}, at), 'finishDev', 'dev', { specHash: hash }, at);
  return {
    root, at, docs: [doc], states: [implemented] as RequirementState[],
    config: { wip: { spec: 3, design: 3 } },
    settings: { timeoutMs: 5000, maxTurns: 9 },
    skill: 'QA-RULES',
    language: { ui: null, ux: null },
    command: 'npm run e2e -- {id}',
    commandTimeoutMs: 7000,
  };
};

test('후보가 없으면 아무것도 실행하지 않는다', async () => {
  const { agent, tasks } = fakeAgent({ output: plan() });
  const { exec, calls } = fakeExec();
  const r = await tickVerify({ ...setup(), states: [register('A', 'req-h', at)], agent, exec });
  assert.equal(r.outcome, 'idle');
  assert.deepEqual([tasks.length, calls.length], [0, 0]);
});

test('QA가 계획과 테스트를 쓰고, 설정된 명령이 통과하면 verified가 된다', async () => {
  const { agent, tasks } = fakeAgent({ output: plan() }, writesTest);
  const { exec, calls } = fakeExec();
  const input = setup();
  const r = await tickVerify({ ...input, agent, exec });
  assert.equal(r.outcome, 'verified', r.message);
  assert.equal(r.state!.status, 'verified');
  assert.equal(readQaPlan(input.root, 'A')?.scenarios[0].id, 'S-1');
  assert.deepEqual([calls[0].command, calls[0].args, calls[0].cwd, calls[0].timeoutMs], ['sh', ['-c', 'npm run e2e -- A'], input.root, 7000]);
  assert.equal(tasks[0].access, 'workspace-write');
});

test('QA 프롬프트는 규칙, 스펙, E2E 자리, 실행 명령을 담는다', async () => {
  const { agent, tasks } = fakeAgent({ output: plan() }, writesTest);
  await tickVerify({ ...setup(), agent, exec: fakeExec().exec });
  for (const piece of ['QA-RULES', '목록을 돌려준다', '`GET /tasks` 계약', 'AC-1', 'e2e/A', 'npm run e2e -- A']) {
    assert.ok(tasks[0].prompt.includes(piece), `프롬프트에 "${piece}"이(가) 없습니다`);
  }
});

test('같은 스펙에 대한 계획이 이미 있으면 QA를 다시 부르지 않고 테스트만 돌린다', async () => {
  const first = fakeAgent({ output: plan() }, writesTest);
  const input = setup();
  await tickVerify({ ...input, agent: first.agent, exec: fakeExec().exec });

  const second = fakeAgent({ output: plan() });
  const { exec, calls } = fakeExec();
  const r = await tickVerify({ ...input, agent: second.agent, exec });
  assert.equal(r.outcome, 'verified', r.message);
  assert.equal(second.tasks.length, 0);
  assert.equal(calls.length, 1);
});

test('명령이 실패하면 정리한 증거와 함께 in-dev로 되돌린다', async () => {
  const { agent } = fakeAgent({ output: plan() }, writesTest);
  const input = setup();
  const failing = (ms: string) => fakeExec({ code: 1, stdout: `not ok 1 - AC-1 (${ms}ms)\n  at ${input.root}/e2e/A/api.test.mjs:3` }).exec;
  const r = await tickVerify({ ...input, agent, exec: failing('12.5') });
  assert.equal(r.outcome, 'failed');
  assert.equal(r.state!.status, 'in-dev');
  assert.match(r.state!.bug!.evidence, /not ok 1 - AC-1/);
  assert.ok(!r.state!.bug!.evidence.includes(input.root));

  // 같은 실패는 실행 시간이 달라도 같은 증거가 된다 (반복 감지에 쓰인다)
  const again = await tickVerify({ ...input, agent, exec: failing('9.1') });
  assert.equal(again.state!.bug!.evidence, r.state!.bug!.evidence);
});

test('명령이 시간 한도를 넘기면 실패로 기록한다', async () => {
  const { agent } = fakeAgent({ output: plan() }, writesTest);
  const r = await tickVerify({ ...setup(), agent, exec: fakeExec({ code: null, timedOut: true }).exec });
  assert.equal(r.outcome, 'failed');
  assert.match(r.state!.bug!.evidence, /시간 한도/);
});

test('인수 조건을 빠뜨린 계획은 받아들이지 않고 테스트도 돌리지 않는다', async () => {
  const { agent } = fakeAgent({ output: plan([]) }, writesTest);
  const { exec, calls } = fakeExec();
  const input = setup();
  const r = await tickVerify({ ...input, agent, exec });
  assert.equal(r.outcome, 'invalid-output');
  assert.match(r.message, /AC-1/);
  assert.equal(r.state, undefined);
  assert.equal(calls.length, 0);
  assert.equal(readQaPlan(input.root, 'A'), null);
});

test('QA가 쓴 뒤 E2E 파일이 바뀌었으면 돌리지 않고 사람에게 묻는다', async () => {
  const { agent } = fakeAgent({ output: plan() }, writesTest);
  const input = setup();
  await tickVerify({ ...input, agent, exec: fakeExec({ code: 1, stdout: 'not ok' }).exec });
  writeFileSync(join(input.root, 'e2e', 'A', 'api.test.mjs'), '// 누군가 고침');

  const { exec, calls } = fakeExec();
  const r = await tickVerify({ ...input, agent, exec });
  assert.equal(r.outcome, 'question');
  assert.deepEqual([r.state!.holds[0].kind, r.state!.holds[0].raisedBy], ['question', 'verify']);
  assert.match(r.state!.holds[0].message, /e2e\/A/);
  assert.equal(calls.length, 0);
});

test('QA가 질문하면 질문 대기가 붙고, 실패하면 상태를 바꾸지 않는다', async () => {
  const asking = fakeAgent({ output: { status: 'question', questions: ['서버는 어떻게 띄우나?'], plan: null } });
  const r = await tickVerify({ ...setup(), agent: asking.agent, exec: fakeExec().exec });
  assert.equal(r.outcome, 'question');
  assert.equal(r.state!.status, 'implemented');

  const failing = fakeAgent({ reason: 'timeout', detail: '초과' });
  const r2 = await tickVerify({ ...setup(), agent: failing.agent, exec: fakeExec().exec });
  assert.equal(r2.outcome, 'agent-failed');
  assert.equal(r2.state, undefined);
});
