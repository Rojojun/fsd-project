import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tickSpec } from '../src/nodes/spec.ts';
import { readSpec, specHash, SPEC_OUTPUT_SCHEMA, writeSpec } from '../src/spec.ts';
import { apply, register } from '../src/transitions.ts';
import type { Agent, AgentResult, AgentTask } from '../src/agents/types.ts';
import type { RequirementDoc, RequirementState } from '../src/model.ts';

const at = '2026-11-17T00:00:00Z';
const usage = { costUsd: 0.1, inputTokens: 10, outputTokens: 5, turns: 2, durationMs: 100 };
const doc = (id: string, extra: Partial<RequirementDoc> = {}): RequirementDoc => ({
  id, title: `${id} 제목`, priority: 'P1', depends: [], policies: [], deprecated: false,
  body: `${id} 본문`, hash: 'req-h', ...extra,
});
const spec = (policies: { id: string; applied: string }[] = []) => ({
  summary: '요약', contract: '계약',
  acceptance: [{ id: 'AC-1', given: 'g', when: 'w', then: 't' }],
  policies,
  design: { needed: false, reason: '화면 없음' },
});
/** 정해진 출력을 돌려주고 받은 과제를 기록하는 에이전트 */
const fakeAgent = (result: { output: unknown } | { reason: 'timeout'; detail: string }) => {
  const tasks: AgentTask[] = [];
  const agent: Agent = async task => {
    tasks.push(task);
    const base = { agent: 'fake', model: 'm', usage };
    return ('output' in result ? { ...base, ok: true, ...result } : { ...base, ok: false, ...result }) as AgentResult;
  };
  return { agent, tasks };
};
const setup = (docs: RequirementDoc[], states: RequirementState[], policies: Record<string, string> = {}) => ({
  root: mkdtempSync(join(tmpdir(), 'agdd-node-')),
  docs, states, policies, at,
  skill: 'SKILL-RULES',
  config: { wip: { spec: 3 } },
  settings: { timeoutMs: 5000, maxTurns: 9 },
});

test('후보가 없으면 에이전트를 부르지 않는다', async () => {
  const { agent, tasks } = fakeAgent({ output: {} });
  const r = await tickSpec({ ...setup([], []), agent });
  assert.equal(r.outcome, 'idle');
  assert.equal(tasks.length, 0);
});

test('에이전트가 질문하면 질문 대기를 붙이고 스펙 파일은 만들지 않는다', async () => {
  const { agent } = fakeAgent({ output: { status: 'question', questions: ['정렬 방향은?', '최대 개수는?'], spec: null } });
  const input = setup([doc('A')], [register('A', 'req-h', at)]);
  const r = await tickSpec({ ...input, agent });
  assert.equal(r.outcome, 'question');
  assert.equal(r.id, 'A');
  const [hold] = r.state!.holds;
  assert.equal(hold.kind, 'question');
  assert.equal(hold.raisedBy, 'spec');
  assert.match(hold.message, /정렬 방향은\?[\s\S]*최대 개수는\?/);
  assert.equal(readSpec(input.root, 'A'), null);
});

test('에이전트가 스펙을 내면 파일로 저장하고 그 해시에 묶인 승인 대기를 붙인다', async () => {
  const { agent } = fakeAgent({ output: { status: 'done', questions: [], spec: spec() } });
  const input = setup([doc('A')], [register('A', 'req-h', at)]);
  const r = await tickSpec({ ...input, agent });
  assert.equal(r.outcome, 'drafted');
  assert.equal(readSpec(input.root, 'A')?.summary, '요약');
  assert.equal(r.state!.status, 'cataloged');
  assert.equal(r.state!.holds[0].kind, 'approval');
  assert.equal(r.state!.holds[0].artifactHash, specHash(input.root, 'A'));
});

test('검사를 통과하지 못한 출력은 상태도 파일도 바꾸지 않는다', async () => {
  const { agent } = fakeAgent({ output: { status: 'done', questions: [], spec: spec() } });
  const input = setup([doc('A', { policies: ['newest-first'] })], [register('A', 'req-h', at)], { 'newest-first': '최신순' });
  const r = await tickSpec({ ...input, agent });
  assert.equal(r.outcome, 'invalid-output');
  assert.match(r.message, /newest-first/);
  assert.equal(r.state, undefined);
  assert.equal(readSpec(input.root, 'A'), null);
});

test('에이전트가 실패하면 상태를 바꾸지 않고 이유를 알린다', async () => {
  const { agent } = fakeAgent({ reason: 'timeout', detail: '5000ms 초과' });
  const r = await tickSpec({ ...setup([doc('A')], [register('A', 'req-h', at)]), agent });
  assert.equal(r.outcome, 'agent-failed');
  assert.match(r.message, /timeout/);
  assert.equal(r.state, undefined);
});

test('과제는 읽기 전용이고 스펙 형식과 설정의 한도를 담는다', async () => {
  const { agent, tasks } = fakeAgent({ output: { status: 'question', questions: ['Q'], spec: null } });
  const input = setup([doc('A')], [register('A', 'req-h', at)]);
  await tickSpec({ ...input, agent, settings: { timeoutMs: 5000, maxTurns: 9, model: 'some-model' } });
  const [task] = tasks;
  assert.equal(task.access, 'read-only');
  assert.equal(task.cwd, input.root);
  assert.equal(task.schema, SPEC_OUTPUT_SCHEMA);
  assert.deepEqual([task.timeoutMs, task.maxTurns, task.model], [5000, 9, 'some-model']);
});

test('프롬프트는 규칙, 요구사항, 정책 원문, 지난 결정과 반려 사유를 담는다', async () => {
  const { agent, tasks } = fakeAgent({ output: { status: 'question', questions: ['Q'], spec: null } });
  const asked = apply(register('A', 'req-h', at), 'ask', 'spec', { question: '정렬 방향은?' }, at);
  const answered = apply(asked, 'answer', 'human', { answer: '내림차순' }, at);
  const drafted = apply(answered, 'draftSpec', 'spec', { specHash: 'x' }, at);
  const rejected = apply(drafted, 'reject', 'human', { reason: '빈 목록 조건이 없음' }, at);
  const input = setup([doc('A', { policies: ['newest-first'] })], [rejected], { 'newest-first': '최신 항목이 먼저 나온다' });
  await tickSpec({ ...input, agent });
  const { prompt } = tasks[0];
  for (const piece of ['SKILL-RULES', 'A 제목', 'A 본문', '최신 항목이 먼저 나온다', '정렬 방향은?', '내림차순', '빈 목록 조건이 없음']) {
    assert.ok(prompt.includes(piece), `프롬프트에 "${piece}"이(가) 없습니다`);
  }
});

test('재확정(stale)이면 이전 스펙을, 선행 요구사항이 있으면 그 확정 스펙을 프롬프트에 담는다', async () => {
  const { agent, tasks } = fakeAgent({ output: { status: 'question', questions: ['Q'], spec: null } });
  const specified = (id: string) =>
    apply(apply(register(id, 'req-h', at), 'draftSpec', 'spec', { specHash: 's' }, at), 'approveSpec', 'human', { specHash: 's' }, at);
  const input = setup(
    [doc('A'), doc('B', { depends: ['A'] })],
    [specified('A'), apply(specified('B'), 'respec', 'human', { reason: '모순' }, at)],
  );
  writeSpec(input.root, doc('A'), { ...spec(), summary: 'A의 확정 스펙' });
  writeSpec(input.root, doc('B'), { ...spec(), summary: 'B의 이전 스펙' });
  await tickSpec({ ...input, agent });
  assert.ok(tasks[0].prompt.includes('A의 확정 스펙'));
  assert.ok(tasks[0].prompt.includes('B의 이전 스펙'));
});

test('에이전트가 질문에 직접 번호를 붙여도 번호가 두 번 붙지 않는다', async () => {
  const { agent } = fakeAgent({ output: { status: 'question', questions: ['1) 첫째?', '2. 둘째?', '(3) 셋째?'], spec: null } });
  const r = await tickSpec({ ...setup([doc('A')], [register('A', 'req-h', at)]), agent });
  assert.equal(r.state!.holds[0].message, '1) 첫째?\n2) 둘째?\n3) 셋째?');
});
