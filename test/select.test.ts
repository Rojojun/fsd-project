import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickNext } from '../src/select.ts';
import { apply, register } from '../src/transitions.ts';
import type { Priority, RequirementDoc, RequirementState } from '../src/model.ts';

const at = '2026-11-17T00:00:00Z';
const config = { wip: { spec: 2 } };
const doc = (id: string, priority: Priority = 'P1', depends: string[] = []): RequirementDoc => ({
  id, title: id, priority, depends, policies: [], deprecated: false, body: 'b', hash: 'h',
});
const cataloged = (id: string) => register(id, 'h', at);
const drafted = (id: string) => apply(cataloged(id), 'draftSpec', 'spec', { specHash: 's' }, at);
const specified = (id: string) => apply(drafted(id), 'approveSpec', 'human', { specHash: 's' }, at);
const inDev = (id: string) => apply(specified(id), 'startDev', 'dev', {}, at);
const implemented = (id: string) => apply(inDev(id), 'finishDev', 'dev', { specHash: 's' }, at);
const bugged = (id: string) => apply(implemented(id), 'failVerify', 'verify', { evidence: 'e' }, at);
const asked = (s: RequirementState) => apply(s, 'ask', 'spec', { question: 'Q' }, at);

test('spec은 우선순위가 높은 것부터, 같으면 ID 순으로 고른다', () => {
  const docs = [doc('B', 'P1'), doc('C', 'P0'), doc('A', 'P1')];
  assert.deepEqual(pickNext('spec', docs, docs.map(d => cataloged(d.id)), config), { id: 'C' });
});

test('hold가 있는 요구사항은 건너뛴다', () => {
  const docs = [doc('A', 'P0'), doc('B', 'P1')];
  assert.deepEqual(pickNext('spec', docs, [asked(cataloged('A')), cataloged('B')], config), { id: 'B' });
});

test('선행 요구사항이 스펙 확정 전이면 건너뛴다', () => {
  const docs = [doc('A', 'P0', ['B']), doc('B', 'P1')];
  assert.deepEqual(pickNext('spec', docs, [cataloged('A'), cataloged('B')], config), { id: 'B' });
  assert.deepEqual(pickNext('spec', docs, [cataloged('A'), specified('B')], config), { id: 'A' });
});

test('stale도 spec 후보다', () => {
  const stale = apply(specified('A'), 'respec', 'human', { reason: 'r' }, at);
  assert.deepEqual(pickNext('spec', [doc('A')], [stale], config), { id: 'A' });
});

test('spec의 승인 대기가 WIP 한도에 닿으면 새 작업을 시작하지 않는다', () => {
  const docs = [doc('A'), doc('B'), doc('C')];
  const r = pickNext('spec', docs, [drafted('A'), drafted('B'), cataloged('C')], config);
  assert.equal(r.id, null);
  assert.match(r.reason ?? '', /WIP/);
  assert.deepEqual(pickNext('spec', docs, [drafted('A'), cataloged('B'), cataloged('C')], config), { id: 'B' });
});

test('dev는 버그 재작업 → 구현 중 → 스펙 확정 순서로 고른다', () => {
  const docs = [doc('A', 'P0'), doc('B', 'P2'), doc('C', 'P2')];
  assert.deepEqual(pickNext('dev', docs, [specified('A'), inDev('B'), bugged('C')], config), { id: 'C' });
  assert.deepEqual(pickNext('dev', docs, [specified('A'), inDev('B'), cataloged('C')], config), { id: 'B' });
  assert.deepEqual(pickNext('dev', docs, [specified('A'), cataloged('B'), cataloged('C')], config), { id: 'A' });
});

test('verify는 구현 완료만 고른다', () => {
  const docs = [doc('A'), doc('B')];
  assert.deepEqual(pickNext('verify', docs, [inDev('A'), implemented('B')], config), { id: 'B' });
});

test('후보가 없으면 이유를 돌려준다', () => {
  const r = pickNext('verify', [doc('A')], [cataloged('A')], config);
  assert.equal(r.id, null);
  assert.match(r.reason ?? '', /후보/);
});
