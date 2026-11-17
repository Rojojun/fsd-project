import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, register, TransitionError } from '../src/transitions.ts';
import type { RequirementState } from '../src/model.ts';

const at = '2026-11-17T00:00:00Z';
const fresh = () => register('REQ-1', 'req-h1', at);
const drafted = () => apply(fresh(), 'draftSpec', 'spec', { specHash: 'spec-h1' }, at);
const specified = () => apply(drafted(), 'approveSpec', 'human', { specHash: 'spec-h1' }, at);
const inDev = () => apply(specified(), 'startDev', 'dev', {}, at);
const implemented = () => apply(inDev(), 'finishDev', 'dev', { specHash: 'spec-h1' }, at);

const assertRejected = (fn: () => RequirementState, pattern: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof TransitionError && pattern.test(e.message));

test('register는 cataloged 상태와 요구사항 지문을 만든다', () => {
  const s = fresh();
  assert.equal(s.status, 'cataloged');
  assert.equal(s.reqHash, 'req-h1');
  assert.deepEqual(s.holds, []);
});

test('draftSpec은 상태를 유지하고 초안 해시에 묶인 승인 대기를 붙인다', () => {
  const s = drafted();
  assert.equal(s.status, 'cataloged');
  assert.equal(s.holds.length, 1);
  assert.equal(s.holds[0].kind, 'approval');
  assert.equal(s.holds[0].artifactHash, 'spec-h1');
});

test('hold가 있으면 노드는 전이할 수 없다', () => {
  assertRejected(() => apply(drafted(), 'draftSpec', 'spec', { specHash: 'spec-h2' }, at), /대기/);
});

test('approveSpec은 초안 해시가 같을 때만 specified로 옮긴다', () => {
  const s = specified();
  assert.equal(s.status, 'specified');
  assert.equal(s.approvedSpecHash, 'spec-h1');
  assert.deepEqual(s.holds, []);
  assertRejected(() => apply(drafted(), 'approveSpec', 'human', { specHash: 'spec-h2' }, at), /해시/);
});

test('승인 대기가 없으면 approveSpec을 할 수 없다', () => {
  assertRejected(() => apply(fresh(), 'approveSpec', 'human', { specHash: 'spec-h1' }, at), /승인 대기/);
});

test('reject는 승인 대기를 떼고 피드백을 남긴다', () => {
  const s = apply(drafted(), 'reject', 'human', { reason: '빈 목록 조건 누락' }, at);
  assert.equal(s.status, 'cataloged');
  assert.deepEqual(s.holds, []);
  assert.equal(s.feedback.at(-1)?.message, '빈 목록 조건 누락');
});

test('from에 없는 상태에서는 전이할 수 없다', () => {
  assertRejected(() => apply(fresh(), 'startDev', 'dev', {}, at), /cataloged/);
});

test('허용되지 않은 주체는 전이할 수 없다', () => {
  assertRejected(() => apply(specified(), 'startDev', 'human', {}, at), /human/);
});

test('ask는 질문 대기를 붙이고 answer는 질문을 떼며 결정을 기록한다', () => {
  const asked = apply(fresh(), 'ask', 'spec', { question: '정렬 방향은?' }, at);
  assert.equal(asked.holds[0].kind, 'question');
  const answered = apply(asked, 'answer', 'human', { holdId: asked.holds[0].id, answer: 'desc' }, at);
  assert.deepEqual(answered.holds, []);
  assert.deepEqual(answered.decisions.at(-1), { question: '정렬 방향은?', answer: 'desc', reqHash: 'req-h1', at });
});

test('질문이 하나뿐이면 answer에 holdId를 생략할 수 있다', () => {
  const asked = apply(fresh(), 'ask', 'spec', { question: 'Q' }, at);
  assert.deepEqual(apply(asked, 'answer', 'human', { answer: 'A' }, at).holds, []);
});

test('질문이 여럿이면 answer에 holdId가 필요하다', () => {
  const once = apply(fresh(), 'ask', 'spec', { question: 'Q1' }, at);
  const twice = { ...once, holds: [...once.holds, { ...once.holds[0], id: 'Q2', message: 'Q2' }] };
  assertRejected(() => apply(twice, 'answer', 'human', { answer: 'A' }, at), /holdId/);
});

test('finishDev는 구현 기준 스펙이 승인 스펙과 다르면 막는다 (Spec Gate)', () => {
  assertRejected(() => apply(inDev(), 'finishDev', 'dev', { specHash: 'spec-old' }, at), /Spec Gate/);
  assert.equal(implemented().status, 'implemented');
});

test('failVerify는 버그 증거와 함께 in-dev로 되돌리고 passVerify는 버그를 지운다', () => {
  const failed = apply(implemented(), 'failVerify', 'verify', { evidence: 'expected desc' }, at);
  assert.equal(failed.status, 'in-dev');
  assert.equal(failed.bug?.evidence, 'expected desc');
  const fixed = apply(failed, 'finishDev', 'dev', { specHash: 'spec-h1' }, at);
  const passed = apply(fixed, 'passVerify', 'verify', {}, at);
  assert.equal(passed.status, 'verified');
  assert.equal(passed.bug, null);
});

test('invalidate는 확정 이후 상태를 stale로 옮기고 hold와 버그를 버린다', () => {
  const asked = apply(implemented(), 'ask', 'verify', { question: 'Q' }, at);
  const s = apply(asked, 'invalidate', 'sync', { reqHash: 'req-h2' }, at);
  assert.equal(s.status, 'stale');
  assert.equal(s.reqHash, 'req-h2');
  assert.deepEqual(s.holds, []);
  assert.equal(s.bug, null);
});

test('reset은 스펙 전 상태에서 초안과 hold를 버린다', () => {
  const s = apply(drafted(), 'reset', 'sync', { reqHash: 'req-h2' }, at);
  assert.equal(s.status, 'cataloged');
  assert.equal(s.reqHash, 'req-h2');
  assert.deepEqual(s.holds, []);
});

test('deprecate와 revive', () => {
  const gone = apply(specified(), 'deprecate', 'sync', {}, at);
  assert.equal(gone.status, 'deprecated');
  assertRejected(() => apply(gone, 'ask', 'spec', { question: 'Q' }, at), /deprecated/);
  const back = apply(gone, 'revive', 'sync', { reqHash: 'req-h3' }, at);
  assert.equal(back.status, 'cataloged');
  assert.equal(back.reqHash, 'req-h3');
});

test('respec은 사람이 확정 스펙을 다시 열 때 stale로 옮긴다', () => {
  assert.equal(apply(specified(), 'respec', 'human', { reason: 'audit 모순' }, at).status, 'stale');
});

test('모든 전이는 이력에 from·to·전이 이름·주체를 남긴다', () => {
  const s = implemented();
  assert.deepEqual(
    s.history.map(h => `${h.from}>${h.to}:${h.transition}:${h.actor}`),
    [
      'null>cataloged:register:sync',
      'cataloged>cataloged:draftSpec:spec',
      'cataloged>specified:approveSpec:human',
      'specified>in-dev:startDev:dev',
      'in-dev>implemented:finishDev:dev',
    ],
  );
});

test('전이는 원본 상태를 바꾸지 않는다', () => {
  const before = fresh();
  const snapshot = structuredClone(before);
  apply(before, 'draftSpec', 'spec', { specHash: 'x' }, at);
  assert.deepEqual(before, snapshot);
});
