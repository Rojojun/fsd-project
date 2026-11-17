import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escalate, flagsOf } from '../src/flags.ts';
import { apply, register } from '../src/transitions.ts';
import type { RequirementDoc, RequirementState } from '../src/model.ts';

const at = '2026-11-17T00:00:00Z';
const limits = { rejections: 3, reworks: 3, sameFailure: 2 };
const doc = (id: string, depends: string[] = []): RequirementDoc => ({
  id, title: id, priority: 'P1', depends, policies: [], design: null, deprecated: false, body: 'b', hash: 'h',
});
const cataloged = (id = 'A') => register(id, 'h', at);
const drafted = (s = cataloged()) => apply(s, 'draftSpec', 'spec', { specHash: 's' }, at);
const rejected = (s = cataloged()) => apply(drafted(s), 'reject', 'human', { reason: 'r' }, at);
const specified = (id = 'A') => apply(drafted(cataloged(id)), 'approveSpec', 'human', { specHash: 's' }, at);
const inDev = () => apply(specified(), 'startDev', 'dev', {}, at);
const finish = (s: RequirementState) => apply(s, 'finishDev', 'dev', { specHash: 's' }, at);
const fail = (s: RequirementState, evidence: string) => apply(finish(s), 'failVerify', 'verify', { evidence }, at);
const flags = (s: RequirementState, d = doc(s.id), all: RequirementState[] = [s]) => flagsOf(s, d, all);

test('대기도 선행 조건도 없는 등록 요구사항은 ready', () => {
  assert.equal(flags(cataloged()).phase, 'ready');
});

test('선행 요구사항의 스펙이 확정 전이면 blocked-by-dependency와 막고 있는 ID를 알려 준다', () => {
  const f = flagsOf(cataloged('A'), doc('A', ['B', 'C']), [cataloged('A'), cataloged('B'), specified('C')]);
  assert.equal(f.phase, 'blocked-by-dependency');
  assert.deepEqual(f.blockedBy, ['B']);
});

test('질문 대기는 다른 단계보다 먼저 보이고 기다린 시각을 알려 준다', () => {
  const asked = apply(rejected(), 'ask', 'spec', { question: 'Q' }, '2026-11-18T00:00:00Z');
  const f = flags(asked);
  assert.equal(f.phase, 'waiting-answer');
  assert.equal(f.waitingSince, '2026-11-18T00:00:00Z');
});

test('승인 대기는 waiting-approval', () => {
  assert.equal(flags(drafted()).phase, 'waiting-approval');
});

test('반려되면 redraft이고 반려 횟수를 센다', () => {
  const twice = rejected(rejected());
  assert.equal(flags(twice).phase, 'redraft');
  assert.equal(flags(twice).rejections, 2);
});

test('요구사항이 바뀌면 반려 횟수는 다시 0부터 센다', () => {
  const changed = apply(rejected(), 'reset', 'sync', { reqHash: 'h2' }, at);
  assert.equal(flags(changed).rejections, 0);
  assert.equal(flags(changed).phase, 'ready');
});

test('stale의 이유를 구분한다', () => {
  const byFile = apply(specified(), 'invalidate', 'sync', { reqHash: 'h2' }, at);
  const byHuman = apply(specified(), 'respec', 'human', { reason: 'r' }, at);
  assert.equal(flags(byFile).staleReason, 'requirement-changed');
  assert.equal(flags(byHuman).staleReason, 'respec');
  assert.equal(flags(specified()).staleReason, null);
});

test('구현 중은 building, 버그 재작업은 rework이고 재작업 횟수를 센다', () => {
  assert.equal(flags(inDev()).phase, 'building');
  const failed = fail(inDev(), 'e1');
  assert.equal(flags(failed).phase, 'rework');
  assert.equal(flags(failed).reworks, 1);
});

test('같은 증거로 연속 실패한 횟수를 센다', () => {
  const same = fail(fail(inDev(), 'e1'), 'e1');
  assert.equal(flags(same).sameFailureStreak, 2);
  const different = fail(same, 'e2');
  assert.equal(flags(different).sameFailureStreak, 1);
  assert.equal(flags(different).reworks, 3);
});

test('사람이 답하면 반복 횟수는 다시 0부터 센다', () => {
  const asked = apply(fail(fail(inDev(), 'e1'), 'e1'), 'ask', 'dev', { question: 'Q' }, at);
  const answered = apply(asked, 'answer', 'human', { answer: '계속' }, at);
  assert.equal(flags(answered).reworks, 0);
  assert.equal(flags(answered).sameFailureStreak, 0);
});

test('끝난 상태는 done과 closed', () => {
  const verified = apply(finish(inDev()), 'passVerify', 'verify', {}, at);
  assert.equal(flags(verified).phase, 'done');
  assert.equal(flags(apply(verified, 'deprecate', 'sync', {}, at)).phase, 'closed');
});

test('escalate: 반려가 한도에 닿으면 spec이 사람에게 결정을 묻는다', () => {
  const s = rejected(rejected(rejected()));
  const r = escalate([s], limits, at);
  assert.deepEqual(r.changes.map(c => c.id), ['A']);
  assert.equal(r.states[0].holds[0].kind, 'question');
  assert.equal(r.states[0].holds[0].raisedBy, 'spec');
  assert.match(r.states[0].holds[0].message, /3/);
});

test('escalate: 재작업이 한도에 닿으면 dev가 묻는다', () => {
  const s = fail(fail(fail(inDev(), 'e1'), 'e2'), 'e3');
  const r = escalate([s], limits, at);
  assert.equal(r.states[0].holds[0].raisedBy, 'dev');
});

test('escalate: 같은 실패가 반복되면 재작업 한도 전이라도 묻는다', () => {
  const s = fail(fail(inDev(), 'e1'), 'e1');
  assert.equal(escalate([s], limits, at).changes.length, 1);
});

test('escalate: 한도 아래면 아무것도 하지 않는다', () => {
  const s = fail(inDev(), 'e1');
  const r = escalate([s, rejected()], limits, at);
  assert.deepEqual(r.changes, []);
  assert.equal(r.states[0], s);
});

test('escalate: 이미 대기 중이면 다시 묻지 않고, 사람이 답한 뒤에도 바로 다시 묻지 않는다', () => {
  const once = escalate([fail(fail(inDev(), 'e1'), 'e1')], limits, at).states[0];
  assert.deepEqual(escalate([once], limits, at).changes, []);
  const answered = apply(once, 'answer', 'human', { answer: '계속' }, at);
  assert.deepEqual(escalate([answered], limits, at).changes, []);
});
