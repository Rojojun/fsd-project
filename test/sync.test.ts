import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sync } from '../src/sync.ts';
import { apply, register } from '../src/transitions.ts';
import type { RequirementDoc, RequirementState } from '../src/model.ts';

const at = '2026-11-17T00:00:00Z';
const doc = (id: string, hash: string, extra: Partial<RequirementDoc> = {}): RequirementDoc => ({
  id, title: id, priority: 'P1', depends: [], policies: [], design: null, deprecated: false, body: 'b', hash, ...extra,
});
const specifiedState = (id: string, hash: string): RequirementState => {
  const drafted = apply(register(id, hash, at), 'draftSpec', 'spec', { specHash: 's' }, at);
  return apply(drafted, 'approveSpec', 'human', { specHash: 's' }, at);
};
const changes = (docs: RequirementDoc[], states: RequirementState[]) =>
  sync(docs, states, at).changes.map(c => `${c.id}:${c.transition}`);

test('새 요구사항 파일은 등록한다', () => {
  const r = sync([doc('A', 'h1')], [], at);
  assert.deepEqual(r.changes.map(c => c.transition), ['register']);
  assert.equal(r.states[0].status, 'cataloged');
});

test('지문이 같으면 아무것도 하지 않는다', () => {
  assert.deepEqual(changes([doc('A', 'h1')], [register('A', 'h1', at)]), []);
});

test('스펙 확정 전 요구사항이 바뀌면 reset', () => {
  assert.deepEqual(changes([doc('A', 'h2')], [register('A', 'h1', at)]), ['A:reset']);
});

test('스펙 확정 후 요구사항이 바뀌면 invalidate로 stale', () => {
  const r = sync([doc('A', 'h2')], [specifiedState('A', 'h1')], at);
  assert.deepEqual(r.changes.map(c => c.transition), ['invalidate']);
  assert.equal(r.states[0].status, 'stale');
});

test('파일이 사라지거나 deprecated: true면 폐기한다', () => {
  assert.deepEqual(changes([], [register('A', 'h1', at)]), ['A:deprecate']);
  assert.deepEqual(changes([doc('A', 'h1', { deprecated: true })], [register('A', 'h1', at)]), ['A:deprecate']);
});

test('이미 폐기된 요구사항은 다시 폐기하지 않는다', () => {
  const gone = apply(register('A', 'h1', at), 'deprecate', 'sync', {}, at);
  assert.deepEqual(changes([], [gone]), []);
});

test('폐기된 요구사항 파일이 다시 살아나면 revive', () => {
  const gone = apply(register('A', 'h1', at), 'deprecate', 'sync', {}, at);
  assert.deepEqual(changes([doc('A', 'h1')], [gone]), ['A:revive']);
});

test('바뀐 파일만 반영하고 나머지 상태는 그대로 둔다', () => {
  const b = register('B', 'hb', at);
  const r = sync([doc('A', 'h2'), doc('B', 'hb')], [register('A', 'h1', at), b], at);
  assert.deepEqual(r.changes.map(c => c.id), ['A']);
  assert.equal(r.states.find(s => s.id === 'B'), b);
});

// ── 선행 관계만 바뀐 경우 ──

const withContent = (s: RequirementState, contentHash: string): RequirementState => ({ ...s, contentHash });
const docC = (id: string, hash: string, contentHash: string) => doc(id, hash, { contentHash });

test('확정된 요구사항의 선행 관계만 바뀌면 무효로 하지 않고 지문만 새로 고친다 (relink)', () => {
  const r = sync([docC('A', 'h2', 'c1')], [withContent(specifiedState('A', 'h1'), 'c1')], at);
  assert.deepEqual(r.changes.map(c => c.transition), ['relink']);
  assert.equal(r.states[0].status, 'specified');
  assert.equal(r.states[0].reqHash, 'h2');
  assert.equal(r.states[0].approvedSpecHash, 's');
  assert.equal(r.states[0].history.at(-1)?.transition, 'relink');
});

test('승인 대기 중인 초안도 선행 관계만 바뀌면 그대로 둔다', () => {
  const drafted = withContent(apply(register('A', 'h1', at), 'draftSpec', 'spec', { specHash: 's' }, at), 'c1');
  const r = sync([docC('A', 'h2', 'c1')], [drafted], at);
  assert.deepEqual(r.changes.map(c => c.transition), ['relink']);
  assert.equal(r.states[0].holds[0]?.kind, 'approval');
});

test('내용이 바뀌면 지금처럼 무효로 한다', () => {
  const r = sync([docC('A', 'h2', 'c2')], [withContent(specifiedState('A', 'h1'), 'c1')], at);
  assert.deepEqual(r.changes.map(c => c.transition), ['invalidate']);
  assert.equal(r.states[0].contentHash, 'c2');
});

test('내용 지문이 없는 예전 상태는, 파일이 그대로일 때 이력 없이 내용 지문을 채운다 (backfill)', () => {
  const old = specifiedState('A', 'h1');
  const r = sync([docC('A', 'h1', 'c1')], [old], at);
  assert.deepEqual(r.changes.map(c => c.transition), ['backfill']);
  assert.equal(r.states[0].contentHash, 'c1');
  assert.equal(r.states[0].history.length, old.history.length);
  assert.equal(r.states[0].status, 'specified');
});

test('내용 지문이 없는 예전 상태에서 파일이 바뀌면 판단할 근거가 없으니 지금처럼 무효로 한다', () => {
  const r = sync([docC('A', 'h2', 'c1')], [specifiedState('A', 'h1')], at);
  assert.deepEqual(r.changes.map(c => c.transition), ['invalidate']);
});

test('새로 등록할 때 내용 지문을 함께 남긴다', () => {
  const r = sync([docC('A', 'h1', 'c1')], [], at);
  assert.equal(r.states[0].contentHash, 'c1');
});
