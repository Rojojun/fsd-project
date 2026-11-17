import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { designHash, readDesign } from '../src/design.ts';
import { tickDesign } from '../src/nodes/design.ts';
import { specHash, writeSpec } from '../src/spec.ts';
import { apply, register } from '../src/transitions.ts';
import type { Agent, AgentResult, AgentTask } from '../src/agents/types.ts';
import type { RequirementDoc, RequirementState } from '../src/model.ts';

const at = '2026-11-17T00:00:00Z';
const usage = { costUsd: 0.1, inputTokens: 10, outputTokens: 5, turns: 2, durationMs: 100 };
const doc: RequirementDoc = {
  id: 'A', title: '목록 화면', priority: 'P1', depends: [], policies: [], design: null, deprecated: false, body: '목록을 화면에 보여 준다', hash: 'req-h',
};
const spec = {
  summary: '요약', contract: '계약', policies: [], design: { needed: true, reason: '화면이 생긴다' },
  acceptance: [{ id: 'AC-1', given: '항목이 없을 때', when: '화면을 연다', then: '빈 목록 안내가 보인다' }],
};
const output = (location = 'ignored') => ({
  status: 'done', questions: [],
  design: { summary: '목록 화면 디자인', location, screens: [{ name: '목록', description: '빈 상태 포함', covers: ['AC-1'] }] },
});
/** 스펙이 승인되어 디자인을 기다리는 작업 폴더 */
const setup = (prepare: (s: RequirementState) => RequirementState = s => s) => {
  const root = mkdtempSync(join(tmpdir(), 'agdd-dnode-'));
  writeSpec(root, doc, spec);
  const hash = specHash(root, 'A')!;
  const drafted = apply(register('A', 'req-h', at), 'draftSpec', 'spec', { specHash: hash }, at);
  const state = prepare(apply(drafted, 'approveSpec', 'human', { specHash: hash, needsDesign: true }, at));
  return {
    root, at, docs: [doc], states: [state],
    config: { wip: { spec: 3, design: 3 } },
    settings: { timeoutMs: 5000, maxTurns: 9 },
    skill: 'DESIGN-RULES',
    surfaceGuide: 'SURFACE-GUIDE',
  };
};
const fakeAgent = (result: { output: unknown } | { reason: 'timeout'; detail: string }, sideEffect: (task: AgentTask) => void = () => {}) => {
  const tasks: AgentTask[] = [];
  const agent: Agent = async task => {
    tasks.push(task);
    sideEffect(task);
    const base = { agent: 'fake', model: 'm', usage };
    return ('output' in result ? { ...base, ok: true, ...result } : { ...base, ok: false, ...result }) as AgentResult;
  };
  return { agent, tasks };
};
const writesHtml = (task: AgentTask) => {
  mkdirSync(join(task.cwd, 'designs', 'A'), { recursive: true });
  writeFileSync(join(task.cwd, 'designs', 'A', 'index.html'), '<!doctype html><html><title>목록</title></html>');
};
const html = { surface: 'html', server: null } as const;

test('디자인이 필요한 요구사항이 없으면 에이전트를 부르지 않는다', async () => {
  const { agent, tasks } = fakeAgent({ output: output() });
  const input = setup();
  const noNeed = apply(apply(register('A', 'req-h', at), 'draftSpec', 'spec', { specHash: 's' }, at), 'approveSpec', 'human', { specHash: 's', needsDesign: false }, at);
  const r = await tickDesign({ ...input, states: [noNeed], agent, ...html });
  assert.equal(r.outcome, 'idle');
  assert.equal(tasks.length, 0);
});

test('html: 에이전트가 쓴 HTML 파일과 요약을 저장하고 그 해시에 묶인 승인 대기를 붙인다', async () => {
  const { agent, tasks } = fakeAgent({ output: output() }, writesHtml);
  const input = setup();
  const r = await tickDesign({ ...input, agent, ...html });
  assert.equal(r.outcome, 'drafted');
  const saved = readDesign(input.root, 'A');
  assert.deepEqual([saved?.surface, saved?.location, saved?.specHash], ['html', 'designs/A/index.html', specHash(input.root, 'A')]);
  const [hold] = r.state!.holds;
  assert.deepEqual([hold.kind, hold.raisedBy, hold.artifactHash], ['approval', 'design', designHash(input.root, 'A')]);
  assert.equal(r.state!.status, 'specified');
  assert.equal(tasks[0].access, 'write-files');
  assert.equal(tasks[0].mcp, undefined);
});

test('html: 에이전트가 파일을 쓰지 않았으면 상태를 바꾸지 않는다', async () => {
  const { agent } = fakeAgent({ output: output() });
  const input = setup();
  const r = await tickDesign({ ...input, agent, ...html });
  assert.equal(r.outcome, 'invalid-output');
  assert.equal(r.state, undefined);
  assert.equal(readDesign(input.root, 'A'), null);
});

test('penpot: 해당 MCP 서버를 쓰게 하고 저장소에는 쓰지 못하게 하며 주소를 저장한다', async () => {
  const { agent, tasks } = fakeAgent({ output: output('https://design.penpot.app/#/view/1') });
  const input = setup();
  const r = await tickDesign({ ...input, agent, surface: 'penpot', server: 'penpot-local' });
  assert.equal(r.outcome, 'drafted');
  assert.equal(readDesign(input.root, 'A')?.location, 'https://design.penpot.app/#/view/1');
  assert.equal(tasks[0].access, 'read-only');
  assert.deepEqual(tasks[0].mcp, ['penpot-local']);
});

test('질문하면 design이 올린 질문 대기가 붙는다', async () => {
  const { agent } = fakeAgent({ output: { status: 'question', questions: ['빈 목록 문구는?'], design: null } });
  const r = await tickDesign({ ...setup(), agent, ...html });
  assert.equal(r.outcome, 'question');
  assert.deepEqual([r.state!.holds[0].kind, r.state!.holds[0].raisedBy], ['question', 'design']);
});

test('에이전트가 실패하면 상태를 바꾸지 않는다', async () => {
  const { agent } = fakeAgent({ reason: 'timeout', detail: '초과' });
  const r = await tickDesign({ ...setup(), agent, ...html });
  assert.equal(r.outcome, 'agent-failed');
  assert.equal(r.state, undefined);
});

test('프롬프트는 규칙, 도구 안내, 요구사항, 확정 스펙, 지난 반려 사유, 저장할 자리를 담는다', async () => {
  const { agent, tasks } = fakeAgent({ output: output() }, writesHtml);
  const rejectedOnce = (s: RequirementState) =>
    apply(apply(s, 'draftDesign', 'design', { designHash: 'd0' }, at), 'reject', 'human', { reason: '여백이 좁다' }, at);
  await tickDesign({ ...setup(rejectedOnce), agent, ...html });
  for (const piece of ['DESIGN-RULES', 'SURFACE-GUIDE', '목록을 화면에 보여 준다', '빈 목록 안내가 보인다', 'AC-1', '여백이 좁다', 'designs/A/index.html']) {
    assert.ok(tasks[0].prompt.includes(piece), `프롬프트에 "${piece}"이(가) 없습니다`);
  }
});
