import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditKey, checkAuditOutput, isSuppressed, specText } from '../src/audit.ts';
import { apply, register } from '../src/transitions.ts';
import type { RequirementDoc } from '../src/model.ts';
import type { SavedSpec } from '../src/spec.ts';

const at = '2026-11-17T00:00:00Z';
const doc = (id: string, body = `${id} 본문`): RequirementDoc => ({
  id, title: `${id} 제목`, priority: 'P1', depends: [], policies: [], design: null, deprecated: false, body, hash: 'h',
});
const spec = (id: string, contract: string): SavedSpec => ({
  id, reqHash: 'h', summary: `${id} 요약`, contract, policies: [], design: { needed: false, reason: 'r' },
  acceptance: [{ id: 'AC-1', given: 'g', when: 'w', then: `${id} 결과` }],
});
const specs = {
  A: spec('A', '- 요소의 필드는 `id`, `title` 둘이다.'),
  B: spec('B', '| `done` | 불리언 | 완료 여부 |\n- 요소의 필드는 `id`, `title`, `done`이다.'),
  C: spec('C', '- 상관없는 계약'),
};
const docs = [doc('A'), doc('B'), doc('C')];
const finding = (over: object = {}) => ({
  kind: 'contradiction', requirements: ['A', 'B'], fixIn: 'A',
  summary: '목록 요소의 필드를 A는 둘, B는 셋으로 정한다',
  evidence: [{ id: 'A', quote: '요소의 필드는 `id`, `title` 둘이다.' }, { id: 'B', quote: '요소의 필드는 `id`, `title`, `done`이다' }],
  suggestion: 'A의 계약을 B와 맞춘다', ...over,
});
const check = (findings: object[]) => checkAuditOutput({ findings }, { specs, docs });

test('인용이 실제 스펙에 있는 지적은 받아들인다', () => {
  const r = check([finding()]);
  assert.ok(r.ok);
  assert.equal(r.findings.length, 1);
  assert.deepEqual(r.rejected, []);
});

test('인용은 띄어쓰기와 마크다운 기호가 달라도 같은 문장이면 맞는 것으로 본다', () => {
  const r = check([finding({ evidence: [{ id: 'A', quote: '요소의 필드는 id, title 둘이다' }, { id: 'B', quote: '`done` 불리언 완료 여부' }] })]);
  assert.ok(r.ok);
  assert.equal(r.findings.length, 1);
});

test('스펙에 없는 문장을 인용한 지적은 버리고 이유를 남긴다', () => {
  const r = check([finding({ evidence: [{ id: 'A', quote: '필드는 넷이다' }, { id: 'B', quote: '요소의 필드는 `id`, `title`, `done`이다' }] })]);
  assert.ok(r.ok);
  assert.equal(r.findings.length, 0);
  assert.match(r.rejected[0].reason, /A.*인용.*없습니다/);
});

test('지적에 든 요구사항마다 인용이 있어야 한다', () => {
  const r = check([finding({ evidence: [{ id: 'A', quote: '요소의 필드는 `id`, `title` 둘이다.' }] })]);
  assert.ok(r.ok);
  assert.match(r.rejected[0].reason, /B.*인용/);
});

test('모순과 중복은 요구사항이 둘 이상이어야 하고, 고칠 곳은 그 가운데 하나여야 한다', () => {
  const one = check([finding({ requirements: ['A'], evidence: [{ id: 'A', quote: '요소의 필드는 `id`, `title` 둘이다.' }] })]);
  assert.match(one.ok ? one.rejected[0].reason : '', /둘 이상/);
  const outside = check([finding({ fixIn: 'C' })]);
  assert.match(outside.ok ? outside.rejected[0].reason : '', /fixIn/);
});

test('검토 대상이 아닌 요구사항을 들면 버린다', () => {
  const r = check([finding({ requirements: ['A', 'Z'], evidence: [{ id: 'A', quote: '요소의 필드는 `id`, `title` 둘이다.' }, { id: 'Z', quote: 'x' }] })]);
  assert.match(r.ok ? r.rejected[0].reason : '', /Z/);
});

test('무효 근거 인용은 요구사항 하나로도 된다', () => {
  const r = check([finding({ kind: 'invalid-reference', requirements: ['B'], fixIn: 'B', evidence: [{ id: 'B', quote: '요소의 필드는 `id`, `title`, `done`이다' }] })]);
  assert.ok(r.ok);
  assert.equal(r.findings.length, 1);
});

test('형식이 아예 다르면 실패다', () => {
  assert.ok(!checkAuditOutput({ findings: 'none' }, { specs, docs }).ok);
  assert.ok(!checkAuditOutput(null, { specs, docs }).ok);
});

test('같은 지적은 같은 키가 된다 (요구사항 순서와 무관)', () => {
  assert.equal(auditKey(finding() as never), auditKey(finding({ requirements: ['B', 'A'] }) as never));
  assert.notEqual(auditKey(finding() as never), auditKey(finding({ kind: 'duplicate' }) as never));
});

test('이미 물어서 답을 기다리는 지적은 다시 올리지 않는다', () => {
  const key = auditKey(finding() as never);
  const asked = apply(register('A', 'h', at), 'ask', 'audit', { question: `[${key}] 질문` }, at);
  assert.equal(isSuppressed(key, ['A', 'B'], [asked, register('B', 'h', at)]), true);
  assert.equal(isSuppressed(key, ['A', 'B'], [register('A', 'h', at), register('B', 'h', at)]), false);
});

test('사람이 문제 아님으로 답한 지적은, 그 뒤 관련 스펙이 다시 확정되기 전까지 올리지 않는다', () => {
  const key = auditKey(finding() as never);
  const specified = (id: string, when: string) =>
    apply(apply(register(id, 'h', when), 'draftSpec', 'spec', { specHash: 's' }, when), 'approveSpec', 'human', { specHash: 's' }, when);
  const asked = apply(specified('A', '2026-11-01T00:00:00Z'), 'ask', 'audit', { question: `[${key}] 질문` }, '2026-11-02T00:00:00Z');
  const dismissed = apply(asked, 'answer', 'human', { answer: '문제 아님' }, '2026-11-03T00:00:00Z');
  assert.equal(isSuppressed(key, ['A', 'B'], [dismissed, specified('B', '2026-11-01T00:00:00Z')]), true);
  // B의 스펙이 그 뒤에 다시 확정되었으면 다시 볼 만하다
  assert.equal(isSuppressed(key, ['A', 'B'], [dismissed, specified('B', '2026-11-05T00:00:00Z')]), false);
});

test('검토할 글에는 요구사항 본문과 스펙이 함께 들어간다', () => {
  const text = specText(doc('A', '목록을 보여 준다'), specs.A);
  assert.match(text, /목록을 보여 준다/);
  assert.match(text, /요소의 필드는/);
  assert.match(text, /AC-1/);
});
