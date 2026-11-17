import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tickAudit } from '../src/nodes/audit.ts';
import { specHash, writeSpec } from '../src/spec.ts';
import { apply, register } from '../src/transitions.ts';
import type { Agent, AgentResult, AgentTask } from '../src/agents/types.ts';
import type { RequirementDoc, RequirementState } from '../src/model.ts';

const at = '2026-11-17T00:00:00Z';
const usage = { costUsd: 0.3, inputTokens: 10, outputTokens: 5, turns: 2, durationMs: 100 };
const doc = (id: string): RequirementDoc => ({
  id, title: `${id} 제목`, priority: 'P1', depends: [], policies: [], design: null, deprecated: false, body: `${id} 본문`, hash: 'h',
});
const contract = { A: '- 요소의 필드는 `id`, `title` 둘이다.', B: '- 요소의 필드는 `id`, `title`, `done`이다.', C: '- 따로 노는 계약' } as const;
type Id = keyof typeof contract;
const finding = (over: object = {}) => ({
  kind: 'contradiction', requirements: ['A', 'B'], fixIn: 'A', summary: '필드 정의가 다르다',
  evidence: [{ id: 'A', quote: '요소의 필드는 `id`, `title` 둘이다.' }, { id: 'B', quote: '요소의 필드는 `id`, `title`, `done`이다.' }],
  suggestion: 'A를 B에 맞춘다', ...over,
});
const fakeAgent = (output: unknown) => {
  const tasks: AgentTask[] = [];
  const agent: Agent = async task => {
    tasks.push(task);
    return { agent: 'fake', model: 'm', usage, ok: true, output } as AgentResult;
  };
  return { agent, tasks };
};
const specified = (root: string, id: Id): RequirementState => {
  writeSpec(root, doc(id), {
    summary: `${id} 요약`, contract: contract[id], policies: [], design: { needed: false, reason: 'r' },
    acceptance: [{ id: 'AC-1', given: 'g', when: 'w', then: 't' }],
  });
  const hash = specHash(root, id)!;
  return apply(apply(register(id, 'h', at), 'draftSpec', 'spec', { specHash: hash }, at), 'approveSpec', 'human', { specHash: hash }, at);
};
const setup = (ids: Id[] = ['A', 'B']) => {
  const root = mkdtempSync(join(tmpdir(), 'fsd-audit-'));
  return {
    root, at, docs: ids.map(doc), states: ids.map(id => specified(root, id)),
    settings: { timeoutMs: 5000, maxTurns: 9 }, skill: 'AUDIT-RULES', policies: {},
  };
};

test('확정된 스펙이 없으면 에이전트를 부르지 않는다', async () => {
  const { agent, tasks } = fakeAgent({ findings: [] });
  const input = setup([]);
  const r = await tickAudit({ ...input, states: [register('A', 'h', at)], docs: [doc('A')], agent });
  assert.equal(r.outcome, 'idle');
  assert.equal(tasks.length, 0);
});

test('지적은 고칠 요구사항에 audit의 질문 대기로 붙는다', async () => {
  const { agent, tasks } = fakeAgent({ findings: [finding()] });
  const r = await tickAudit({ ...setup(), agent });
  assert.equal(r.outcome, 'findings', r.message);
  const changed = r.states!;
  assert.deepEqual(changed.map(s => s.id), ['A']);
  const [hold] = changed[0].holds;
  assert.deepEqual([hold.kind, hold.raisedBy], ['question', 'audit']);
  for (const piece of ['교차 모순', '필드 정의가 다르다', '요소의 필드는 `id`, `title` 둘이다.', 'B', 'A를 B에 맞춘다', 'fsd respec A', 'fsd answer A']) {
    assert.ok(hold.message.includes(piece), `질문에 "${piece}"이(가) 없습니다`);
  }
  assert.equal(tasks[0].access, 'read-only');
  for (const piece of ['AUDIT-RULES', 'A 제목', 'B 본문', '요소의 필드는 `id`, `title`, `done`이다.']) {
    assert.ok(tasks[0].prompt.includes(piece), `프롬프트에 "${piece}"이(가) 없습니다`);
  }
});

test('지적이 없으면 clean이고 아무 상태도 바꾸지 않는다', async () => {
  const r = await tickAudit({ ...setup(), agent: fakeAgent({ findings: [] }).agent });
  assert.equal(r.outcome, 'clean');
  assert.deepEqual(r.states, []);
});

test('스펙이 그대로면 다시 돌리지 않고, 바뀌면 다시 돈다', async () => {
  const input = setup();
  await tickAudit({ ...input, agent: fakeAgent({ findings: [] }).agent });
  const again = fakeAgent({ findings: [] });
  const r = await tickAudit({ ...input, agent: again.agent });
  assert.equal(r.outcome, 'idle');
  assert.equal(again.tasks.length, 0);

  const withC = { ...input, docs: [...input.docs, doc('C')], states: [...input.states, specified(input.root, 'C')] };
  const third = fakeAgent({ findings: [] });
  await tickAudit({ ...withC, agent: third.agent });
  assert.equal(third.tasks.length, 1);
});

test('에이전트가 실패하면 다음에 다시 돌도록 아무것도 기록하지 않는다', async () => {
  const input = setup();
  const failing: Agent = async () => ({ agent: 'fake', model: 'm', usage, ok: false, reason: 'timeout', detail: '초과' });
  const r = await tickAudit({ ...input, agent: failing });
  assert.equal(r.outcome, 'agent-failed');
  const next = fakeAgent({ findings: [] });
  await tickAudit({ ...input, agent: next.agent });
  assert.equal(next.tasks.length, 1);
});

test('인용이 틀린 지적은 버리고, 버린 이유를 알려 준다', async () => {
  const wrong = finding({ evidence: [{ id: 'A', quote: '없는 문장' }, { id: 'B', quote: '요소의 필드는 `id`, `title`, `done`이다.' }] });
  const r = await tickAudit({ ...setup(), agent: fakeAgent({ findings: [wrong] }).agent });
  assert.equal(r.outcome, 'clean');
  assert.match(r.message, /버린 지적 1건.*인용/s);
});

test('한 번에 최대 다섯 건만 올린다', async () => {
  const ids: Id[] = ['A', 'B', 'C'];
  const many = Array.from({ length: 7 }, (_, i) => finding({ kind: 'invalid-reference', requirements: [ids[i % 2]], fixIn: ids[i % 2], summary: `지적 ${i}`,
    evidence: [{ id: ids[i % 2], quote: contract[ids[i % 2]].slice(2) }] }));
  // 같은 요구사항에는 질문을 하나만 붙일 수 있으므로, 지적이 여럿이면 한 질문으로 묶는다
  const r = await tickAudit({ ...setup(ids), agent: fakeAgent({ findings: many }).agent });
  assert.equal(r.outcome, 'findings');
  assert.match(r.message, /5건/);
  assert.match(r.message, /2건.*다음/);
});

test('고칠 요구사항이 이미 대기 중이면 그 지적은 이번에 올리지 않는다', async () => {
  const input = setup();
  const busy = input.states.map(s => (s.id === 'A' ? apply(s, 'ask', 'spec', { question: '다른 질문' }, at) : s));
  const r = await tickAudit({ ...input, states: busy, agent: fakeAgent({ findings: [finding()] }).agent });
  assert.equal(r.outcome, 'clean');
  assert.match(r.message, /A.*대기 중/);
});

test('같은 지적이 이미 열려 있으면 다시 올리지 않는다', async () => {
  const input = setup();
  const first = await tickAudit({ ...input, agent: fakeAgent({ findings: [finding()] }).agent });
  const states = input.states.map(s => first.states!.find(c => c.id === s.id) ?? s);
  writeFileSync(join(input.root, '.fsd', 'audit', 'last.json'), '{}');
  const r = await tickAudit({ ...input, states, agent: fakeAgent({ findings: [finding({ fixIn: 'B' })] }).agent });
  assert.equal(r.outcome, 'clean');
  assert.match(r.message, /이미/);
});

test('검토 결과를 파일로 남긴다', async () => {
  const input = setup();
  await tickAudit({ ...input, agent: fakeAgent({ findings: [finding()] }).agent });
  assert.ok(existsSync(join(input.root, '.fsd', 'audit', 'last.json')));
});
