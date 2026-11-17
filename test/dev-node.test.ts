import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { designHash, writeDesign } from '../src/design.ts';
import { tickDev } from '../src/nodes/dev.ts';
import { readNotes } from '../src/notes.ts';
import { specHash, writeSpec } from '../src/spec.ts';
import { apply, register } from '../src/transitions.ts';
import type { Agent, AgentResult, AgentTask } from '../src/agents/types.ts';
import type { RequirementDoc, RequirementState } from '../src/model.ts';

const at = '2026-11-17T00:00:00Z';
const usage = { costUsd: 0.1, inputTokens: 10, outputTokens: 5, turns: 2, durationMs: 100 };
const doc: RequirementDoc = {
  id: 'A', title: '목록', priority: 'P1', depends: [], policies: [], design: null, deprecated: false, body: '목록을 보여 준다', hash: 'req-h',
};
const spec = (needed: boolean) => ({
  summary: '요약', contract: '`GET /tasks` 계약', policies: [], design: { needed, reason: 'r' },
  acceptance: [{ id: 'AC-1', given: 'g', when: 'w', then: '빈 배열을 돌려준다' }],
});
const done = (files: string[], summary = '구현함', notes = '') => ({ status: 'done', questions: [], summary, files, notes });

type Reply = { output: unknown } | { reason: 'timeout' | 'turn-limit'; detail: string };
/** 받은 과제를 기록하고 정해진 답을 주는 에이전트. 시작과 끝 시각을 남겨 병렬 실행을 확인한다. */
const fakeAgent = (reply: Reply, sideEffect: (task: AgentTask) => void = () => {}) => {
  const tasks: AgentTask[] = [];
  const spans: { start: number; end: number }[] = [];
  const agent: Agent = async task => {
    const span = { start: performance.now(), end: 0 };
    spans.push(span);
    tasks.push(task);
    sideEffect(task);
    await new Promise(resolve => setTimeout(resolve, 30));
    span.end = performance.now();
    const base = { agent: 'fake', model: 'm', usage };
    return ('output' in reply ? { ...base, ok: true, ...reply } : { ...base, ok: false, ...reply }) as AgentResult;
  };
  return { agent, tasks, spans };
};

/** 스펙이 확정된(디자인이 필요하면 디자인까지 확정된) 작업 폴더 */
const setup = (withDesign: boolean, prepare: (s: RequirementState, root: string) => RequirementState = s => s) => {
  const root = mkdtempSync(join(tmpdir(), 'agdd-dev-'));
  writeSpec(root, doc, spec(withDesign));
  const sHash = specHash(root, 'A')!;
  let state = apply(apply(register('A', 'req-h', at), 'draftSpec', 'spec', { specHash: sHash }, at), 'approveSpec', 'human', { specHash: sHash, needsDesign: withDesign }, at);
  if (withDesign) {
    mkdirSync(join(root, 'designs', 'A'), { recursive: true });
    writeFileSync(join(root, 'designs', 'A', 'index.html'), '<!doctype html><html></html>');
    writeDesign(root, 'A', { surface: 'html', location: 'designs/A/index.html', summary: '목록 화면 디자인', specHash: sHash, codified: [], screens: [{ name: '빈 목록', description: '안내가 보인다', covers: ['AC-1'] }] });
    const dHash = designHash(root, 'A')!;
    state = apply(apply(state, 'draftDesign', 'design', { designHash: dHash }, at), 'approveDesign', 'human', { designHash: dHash }, at);
  }
  return {
    root, at, docs: [doc], states: [prepare(state, root)],
    config: { wip: { spec: 3, design: 3 } },
    settings: { timeoutMs: 5000, maxTurns: 9 },
    skill: 'DEV-RULES',
    partGuides: { backend: 'BACKEND-GUIDE', frontend: 'FRONTEND-GUIDE' },
    language: { ui: 'UI-LANGUAGE', ux: 'UX-LANGUAGE' },
  };
};
const one = (agent: Agent) => ({ full: agent, backend: agent, frontend: agent });

test('후보가 없으면 에이전트를 부르지 않는다', async () => {
  const { agent, tasks } = fakeAgent({ output: done([]) });
  const r = await tickDev({ ...setup(false), states: [register('A', 'req-h', at)], agents: one(agent) });
  assert.equal(r.outcome, 'idle');
  assert.equal(tasks.length, 0);
});

test('디자인이 없는 요구사항은 에이전트 하나가 구현하고 implemented가 된다', async () => {
  const { agent, tasks } = fakeAgent({ output: done(['app/tasks.mjs']) });
  const r = await tickDev({ ...setup(false), agents: one(agent) });
  assert.equal(r.outcome, 'implemented', r.message);
  assert.equal(r.state!.status, 'implemented');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].access, 'workspace-write');
  assert.deepEqual(r.runs!.map(x => x.part), ['full']);
});

test('프롬프트는 규칙, 요구사항, 확정 스펙, 사람의 결정을 담는다', async () => {
  const { agent, tasks } = fakeAgent({ output: done(['a']) });
  const withDecision = (s: RequirementState) => ({ ...s, decisions: [{ question: '정렬 방향은?', answer: '내림차순', reqHash: 'req-h', at }] });
  await tickDev({ ...setup(false, withDecision), agents: one(agent) });
  for (const piece of ['DEV-RULES', '목록을 보여 준다', '`GET /tasks` 계약', 'AC-1', '빈 배열을 돌려준다', '정렬 방향은?', '내림차순']) {
    assert.ok(tasks[0].prompt.includes(piece), `프롬프트에 "${piece}"이(가) 없습니다`);
  }
  assert.ok(!tasks[0].prompt.includes('BACKEND-GUIDE'));
});

test('디자인이 있으면 백엔드와 프론트엔드로 나눠 동시에 실행한다', async () => {
  const back = fakeAgent({ output: done(['server/tasks.mjs'], '백엔드 구현') });
  const front = fakeAgent({ output: done(['web/list.html'], '화면 구현') });
  const r = await tickDev({ ...setup(true), agents: { full: back.agent, backend: back.agent, frontend: front.agent } });
  assert.equal(r.outcome, 'implemented', r.message);
  assert.deepEqual(r.runs!.map(x => x.part).sort(), ['backend', 'frontend']);
  assert.match(r.message, /백엔드 구현/);
  assert.match(r.message, /화면 구현/);
  // 둘이 겹쳐서 돌았다: 한쪽이 끝나기 전에 다른 쪽이 시작했다
  assert.ok(front.spans[0].start < back.spans[0].end && back.spans[0].start < front.spans[0].end, '동시에 실행되어야 한다');
});

test('나눠 실행할 때 각자 자기 안내만 받고, 프론트엔드는 디자인과 디자인 언어를 받는다', async () => {
  const back = fakeAgent({ output: done(['server/a']) });
  const front = fakeAgent({ output: done(['web/a']) });
  await tickDev({ ...setup(true), agents: { full: back.agent, backend: back.agent, frontend: front.agent } });
  const [b, f] = [back.tasks[0].prompt, front.tasks[0].prompt];
  assert.ok(b.includes('BACKEND-GUIDE') && !b.includes('FRONTEND-GUIDE'));
  assert.ok(f.includes('FRONTEND-GUIDE') && !f.includes('BACKEND-GUIDE'));
  for (const piece of ['목록 화면 디자인', 'designs/A/index.html', '빈 목록', 'UI-LANGUAGE', 'UX-LANGUAGE']) {
    assert.ok(f.includes(piece), `프론트엔드 프롬프트에 "${piece}"이(가) 없습니다`);
  }
  assert.ok(!b.includes('UI-LANGUAGE'));
  assert.ok(b.includes('`GET /tasks` 계약') && f.includes('`GET /tasks` 계약'), '둘 다 같은 계약을 본다');
});

test('백엔드와 프론트엔드가 같은 파일을 고쳤으면 구현 완료로 넘기지 않는다', async () => {
  const back = fakeAgent({ output: done(['shared/api.mjs']) });
  const front = fakeAgent({ output: done(['web/a', './shared/api.mjs']) });
  const r = await tickDev({ ...setup(true), agents: { full: back.agent, backend: back.agent, frontend: front.agent } });
  assert.equal(r.outcome, 'invalid-output');
  assert.match(r.message, /shared\/api\.mjs/);
  assert.equal(r.state!.status, 'in-dev');
});

test('한쪽이라도 질문하면 어느 쪽의 질문인지와 함께 질문 대기가 붙는다', async () => {
  const back = fakeAgent({ output: done(['server/a']) });
  const front = fakeAgent({ output: { status: 'question', questions: ['오류 문구는?'], summary: '', files: [], notes: '' } });
  const r = await tickDev({ ...setup(true), agents: { full: back.agent, backend: back.agent, frontend: front.agent } });
  assert.equal(r.outcome, 'question');
  assert.equal(r.state!.status, 'in-dev');
  assert.deepEqual([r.state!.holds[0].kind, r.state!.holds[0].raisedBy], ['question', 'dev']);
  assert.match(r.state!.holds[0].message, /프론트엔드.*오류 문구는\?/s);
});

test('에이전트가 실패하면 구현 중에 머물고, 다음 사이클이 이어서 한다', async () => {
  const { agent } = fakeAgent({ reason: 'turn-limit', detail: '턴 한도' });
  const input = setup(false);
  const r = await tickDev({ ...input, agents: one(agent) });
  assert.equal(r.outcome, 'agent-failed');
  assert.equal(r.state!.status, 'in-dev');
  assert.match(r.message, /turn-limit/);

  const again = fakeAgent({ output: done(['app/a']) });
  const r2 = await tickDev({ ...input, states: [r.state!], agents: one(again.agent) });
  assert.equal(r2.outcome, 'implemented', r2.message);
});

test('dev가 스펙을 고쳤으면 Spec Gate에 걸려 구현 완료가 되지 않는다', async () => {
  const cheat = (task: AgentTask) => writeFileSync(join(task.cwd, 'specs', 'A', 'spec.json'), '{"acceptance":[]}');
  const { agent } = fakeAgent({ output: done(['app/a']) }, cheat);
  const r = await tickDev({ ...setup(false), agents: one(agent) });
  assert.equal(r.outcome, 'invalid-output');
  assert.match(r.message, /Spec Gate/);
  assert.equal(r.state!.status, 'in-dev');
});

test('dev가 E2E 폴더를 고쳤으면 구현 완료가 되지 않는다', async () => {
  const prepare = (s: RequirementState, root: string) => {
    mkdirSync(join(root, 'e2e', 'A'), { recursive: true });
    writeFileSync(join(root, 'e2e', 'A', 'a.test.mjs'), 'assert(false)');
    return s;
  };
  const cheat = (task: AgentTask) => writeFileSync(join(task.cwd, 'e2e', 'A', 'a.test.mjs'), 'assert(true)');
  const { agent } = fakeAgent({ output: done(['app/a']) }, cheat);
  const r = await tickDev({ ...setup(false, prepare), agents: one(agent) });
  assert.equal(r.outcome, 'invalid-output');
  assert.match(r.message, /e2e\/A/);
});

test('버그 재작업이면 실패 증거를 프롬프트에 담는다', async () => {
  const toBug = (s: RequirementState, root: string) => {
    const inDev = apply(s, 'startDev', 'dev', {}, at);
    const implemented = apply(inDev, 'finishDev', 'dev', { specHash: specHash(root, 'A')! }, at);
    return apply(implemented, 'failVerify', 'verify', { evidence: 'AC-1: expected [] got null' }, at);
  };
  const { agent, tasks } = fakeAgent({ output: done(['app/a']) });
  const r = await tickDev({ ...setup(false, toBug), agents: one(agent) });
  assert.equal(r.outcome, 'implemented', r.message);
  assert.ok(tasks[0].prompt.includes('AC-1: expected [] got null'));
});

test('인계 메모를 남기고, 다음 사이클의 프롬프트에 담는다', async () => {
  const first = fakeAgent({ output: { status: 'question', questions: ['Q'], summary: '', files: [], notes: '저장은 app/store.mjs의 배열로 한다' } });
  const input = setup(false);
  const r = await tickDev({ ...input, agents: one(first.agent) });
  assert.match(readNotes(input.root, 'A'), /app\/store\.mjs의 배열/);

  const answered = apply(r.state!, 'answer', 'human', { answer: 'A' }, at);
  const second = fakeAgent({ output: done(['app/a']) });
  await tickDev({ ...input, states: [answered], agents: one(second.agent) });
  assert.ok(second.tasks[0].prompt.includes('저장은 app/store.mjs의 배열로 한다'));
});
