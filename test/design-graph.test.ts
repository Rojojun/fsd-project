import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escalate, flagsOf } from '../src/flags.ts';
import { pickNext } from '../src/select.ts';
import { apply, register, TransitionError } from '../src/transitions.ts';
import type { RequirementDoc, RequirementState } from '../src/model.ts';

const at = '2026-11-17T00:00:00Z';
const config = { wip: { spec: 3, design: 2 } };
const limits = { rejections: 3, reworks: 3, sameFailure: 2 };
const doc = (id: string, depends: string[] = []): RequirementDoc => ({
  id, title: id, priority: 'P1', depends, policies: [], design: null, deprecated: false, body: 'b', hash: 'h',
});
const specified = (id: string, needsDesign: boolean) => {
  const drafted = apply(register(id, 'h', at), 'draftSpec', 'spec', { specHash: 's' }, at);
  return apply(drafted, 'approveSpec', 'human', { specHash: 's', needsDesign }, at);
};
const designDrafted = (id = 'A') => apply(specified(id, true), 'draftDesign', 'design', { designHash: 'd1' }, at);
const designed = (id = 'A') => apply(designDrafted(id), 'approveDesign', 'human', { designHash: 'd1' }, at);
const rejects = (pattern: RegExp, fn: () => RequirementState) =>
  assert.throws(fn, (e: unknown) => e instanceof TransitionError && pattern.test(e.message));

test('스펙 승인은 디자인 필요 여부를 함께 확정한다', () => {
  assert.equal(specified('A', true).designRequired, true);
  assert.equal(specified('A', false).designRequired, false);
  assert.equal(register('A', 'h', at).designRequired, false);
});

test('draftDesign은 디자인이 필요한 요구사항에만 승인 대기를 붙인다', () => {
  const s = designDrafted();
  assert.equal(s.status, 'specified');
  assert.deepEqual([s.holds[0].kind, s.holds[0].raisedBy, s.holds[0].artifactHash], ['approval', 'design', 'd1']);
  rejects(/디자인이 필요/, () => apply(specified('A', false), 'draftDesign', 'design', { designHash: 'd1' }, at));
});

test('approveDesign은 디자인 해시가 같을 때만 designed로 옮긴다', () => {
  const s = designed();
  assert.equal(s.status, 'designed');
  assert.equal(s.approvedDesignHash, 'd1');
  assert.deepEqual(s.holds, []);
  rejects(/해시/, () => apply(designDrafted(), 'approveDesign', 'human', { designHash: 'other' }, at));
  rejects(/승인 대기/, () => apply(specified('A', true), 'approveDesign', 'human', { designHash: 'd1' }, at));
});

test('디자인이 필요한 요구사항은 디자인 승인 전에 구현을 시작할 수 없다', () => {
  rejects(/디자인/, () => apply(specified('A', true), 'startDev', 'dev', {}, at));
  assert.equal(apply(designed(), 'startDev', 'dev', {}, at).status, 'in-dev');
  assert.equal(apply(specified('A', false), 'startDev', 'dev', {}, at).status, 'in-dev');
});

test('finishDev는 구현 기준 디자인이 승인된 디자인과 다르면 막는다 (Design Gate)', () => {
  const inDev = apply(designed(), 'startDev', 'dev', {}, at);
  rejects(/Design Gate/, () => apply(inDev, 'finishDev', 'dev', { specHash: 's', designHash: 'changed' }, at));
  rejects(/Design Gate/, () => apply(inDev, 'finishDev', 'dev', { specHash: 's' }, at));
  assert.equal(apply(inDev, 'finishDev', 'dev', { specHash: 's', designHash: 'd1' }, at).status, 'implemented');
});

test('스펙을 다시 확정하면 이전 디자인 승인은 사라진다', () => {
  const stale = apply(designed(), 'respec', 'human', { reason: 'r' }, at);
  assert.equal(stale.status, 'stale');
  const again = apply(apply(stale, 'draftSpec', 'spec', { specHash: 's2' }, at), 'approveSpec', 'human', { specHash: 's2', needsDesign: true }, at);
  assert.equal(again.approvedDesignHash, null);
  assert.equal(again.status, 'specified');
});

test('디자인 초안 반려는 specified에 머물며 redraft가 되고, 스펙 반려 횟수와 따로 센다', () => {
  const specRejected = apply(apply(register('A', 'h', at), 'draftSpec', 'spec', { specHash: 's' }, at), 'reject', 'human', { reason: 'r' }, at);
  const approved = apply(apply(specRejected, 'draftSpec', 'spec', { specHash: 's' }, at), 'approveSpec', 'human', { specHash: 's', needsDesign: true }, at);
  assert.equal(flagsOf(approved, doc('A'), [approved]).rejections, 0);
  const rejected = apply(apply(approved, 'draftDesign', 'design', { designHash: 'd1' }, at), 'reject', 'human', { reason: '여백이 좁다' }, at);
  const f = flagsOf(rejected, doc('A'), [rejected]);
  assert.deepEqual([rejected.status, f.phase, f.rejections], ['specified', 'redraft', 1]);
});

test('escalate: 디자인 반려가 한도에 닿으면 design이 사람에게 묻는다', () => {
  const reject = (s: RequirementState) =>
    apply(apply(s, 'draftDesign', 'design', { designHash: 'd' }, at), 'reject', 'human', { reason: 'r' }, at);
  const r = escalate([reject(reject(reject(specified('A', true))))], limits, at);
  assert.equal(r.states[0].holds[0]?.raisedBy, 'design');
});

test('design 노드는 디자인이 필요한 specified만 고른다', () => {
  const docs = [doc('A'), doc('B')];
  assert.deepEqual(pickNext('design', docs, [specified('A', false), specified('B', true)], config), { id: 'B' });
  assert.equal(pickNext('design', docs, [specified('A', false), designed('B')], config).id, null);
});

test('design의 승인 대기가 WIP 한도에 닿으면 새 디자인을 시작하지 않는다', () => {
  const docs = [doc('A'), doc('B'), doc('C')];
  const r = pickNext('design', docs, [designDrafted('A'), designDrafted('B'), specified('C', true)], config);
  assert.equal(r.id, null);
  assert.match(r.reason ?? '', /WIP/);
});

test('dev는 디자인이 필요 없는 specified와 designed를 고르고, 디자인을 기다리는 것은 건너뛴다', () => {
  const docs = [doc('A'), doc('B'), doc('C')];
  assert.deepEqual(pickNext('dev', docs, [specified('A', true), specified('B', false), designed('C')], config), { id: 'B' });
  assert.deepEqual(pickNext('dev', docs, [specified('A', true), designed('C')], config), { id: 'C' });
  assert.equal(pickNext('dev', docs, [specified('A', true)], config).id, null);
});

test('designed도 선행 요구사항의 스펙이 확정된 것으로 본다', () => {
  const docs = [doc('A'), doc('B', ['A'])];
  assert.deepEqual(pickNext('spec', docs, [designed('A'), register('B', 'h', at)], config), { id: 'B' });
});

// ── UI/UX 두 관점의 검토, 디자인 언어가 없을 때의 되돌림 ──

const reviewOf = (s: RequirementState) => flagsOf(s, doc(s.id), [s]).review;

test('디자인 초안은 UI와 UX 두 관점의 승인 대기를 따로 붙인다', () => {
  const s = designDrafted();
  assert.deepEqual(s.holds.map(h => h.aspect), ['ui', 'ux']);
  assert.equal(new Set(s.holds.map(h => h.id)).size, 2);
  assert.deepEqual(reviewOf(s), { ui: 'pending', ux: 'pending' });
});

test('한 관점만 승인하면 specified에 머물고, 두 관점이 모두 승인되어야 designed가 된다', () => {
  const uiOnly = apply(designDrafted(), 'approveDesign', 'human', { designHash: 'd1', aspect: 'ui' }, at);
  assert.equal(uiOnly.status, 'specified');
  assert.equal(uiOnly.approvedDesignHash, null);
  assert.deepEqual(reviewOf(uiOnly), { ui: 'approved', ux: 'pending' });
  rejects(/대기/, () => apply(uiOnly, 'startDev', 'dev', {}, at));

  const both = apply(uiOnly, 'approveDesign', 'human', { designHash: 'd1', aspect: 'ux' }, at);
  assert.equal(both.status, 'designed');
  assert.equal(both.approvedDesignHash, 'd1');
  assert.deepEqual(reviewOf(both), { ui: 'approved', ux: 'approved' });
});

test('이미 승인한 관점을 다시 승인할 수 없다', () => {
  const uiOnly = apply(designDrafted(), 'approveDesign', 'human', { designHash: 'd1', aspect: 'ui' }, at);
  rejects(/ui/, () => apply(uiOnly, 'approveDesign', 'human', { designHash: 'd1', aspect: 'ui' }, at));
});

test('한 관점에서 반려하면 초안 전체가 다시 그리기로 가고, 어느 관점의 지적인지 남는다', () => {
  const uiApproved = apply(designDrafted(), 'approveDesign', 'human', { designHash: 'd1', aspect: 'ui' }, at);
  const rejected = apply(uiApproved, 'reject', 'human', { reason: '완료 후 무엇이 바뀌었는지 알 수 없다', aspect: 'ux' }, at);
  assert.deepEqual(rejected.holds, []);
  assert.deepEqual(rejected.feedback.at(-1), { message: '완료 후 무엇이 바뀌었는지 알 수 없다', specHash: 'd1', at, about: 'design', aspect: 'ux' });
  assert.deepEqual(reviewOf(rejected), { ui: 'none', ux: 'rejected' });
});

test('관점을 밝히지 않은 반려는 두 관점 모두의 반려다', () => {
  const rejected = apply(designDrafted(), 'reject', 'human', { reason: '전체적으로 다시' }, at);
  assert.deepEqual(reviewOf(rejected), { ui: 'rejected', ux: 'rejected' });
});

test('스펙 초안의 반려는 스펙에 대한 지적으로 남는다', () => {
  const drafted = apply(register('A', 'h', at), 'draftSpec', 'spec', { specHash: 's' }, at);
  assert.equal(apply(drafted, 'reject', 'human', { reason: 'r' }, at).feedback.at(-1)?.about, 'spec');
});

test('디자인이 필요 없으면 검토 플래그가 없고, 초안 전이면 none이다', () => {
  assert.equal(reviewOf(specified('A', false)), null);
  assert.deepEqual(reviewOf(specified('A', true)), { ui: 'none', ux: 'none' });
});

test('returnToSpec: design은 디자인 언어가 없으면 요구사항을 spec 단계로 되돌리고 이유를 남긴다', () => {
  const s = apply(specified('A', true), 'returnToSpec', 'design', { reason: '디자인 언어가 정해지지 않았다' }, at);
  assert.equal(s.status, 'stale');
  assert.deepEqual(s.feedback.at(-1), { message: '디자인 언어가 정해지지 않았다', specHash: 's', at, about: 'spec' });
  assert.equal(flagsOf(s, doc('A'), [s]).staleReason, 'design-returned');
  assert.deepEqual(pickNext('spec', [doc('A')], [s], config), { id: 'A' });
  rejects(/human/, () => apply(specified('A', true), 'returnToSpec', 'human', { reason: 'r' }, at));
});
