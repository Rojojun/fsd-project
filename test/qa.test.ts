import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkQaPlan, normalizeEvidence, renderQaPlan } from '../src/qa.ts';
import type { SavedDesign } from '../src/design.ts';
import type { SavedSpec } from '../src/spec.ts';

const spec: SavedSpec = {
  id: 'A', reqHash: 'r', summary: 's', contract: 'c', policies: [], design: { needed: true, reason: 'r' },
  acceptance: [
    { id: 'AC-1', given: 'g', when: 'w', then: '최신순으로 보인다' },
    { id: 'AC-2', given: 'g', when: 'w', then: '빈 목록 안내가 보인다' },
    { id: 'AC-3', given: 'g', when: 'w', then: '404를 돌려준다' },
  ],
};
const design: SavedDesign = {
  surface: 'html', location: 'designs/A/index.html', summary: 'd', specHash: 'h', codified: [],
  screens: [
    { name: '목록', description: '항목이 보인다', covers: ['AC-1'] },
    { name: '빈 목록', description: '안내가 보인다', covers: ['AC-2'] },
  ],
};
const scenario = (id: string, over: object = {}) => ({
  id, target: 'api', screen: '', covers: ['AC-1'], basis: 'acceptance',
  title: '제목', steps: '요청한다', expected: '결과가 온다', file: 'e2e/A/api.test.mjs', ...over,
});
const apiPlan = [scenario('S-1'), scenario('S-2', { covers: ['AC-2'] }), scenario('S-3', { covers: ['AC-3'] })];
const screenPlan = [
  scenario('S-1', { target: 'screen', screen: '목록', file: 'e2e/A/screen.test.mjs' }),
  scenario('S-2', { target: 'screen', screen: '빈 목록', covers: ['AC-2'], file: 'e2e/A/screen.test.mjs' }),
  scenario('S-3', { covers: ['AC-3'] }),
  scenario('S-4', { target: 'screen', screen: '목록', covers: [], basis: 'ux', title: '키보드로 완료 버튼을 누른다', file: 'e2e/A/screen.test.mjs' }),
];
const workspace = (files = ['api.test.mjs', 'screen.test.mjs']) => {
  const root = mkdtempSync(join(tmpdir(), 'fsd-qa-'));
  mkdirSync(join(root, 'e2e', 'A'), { recursive: true });
  files.forEach(f => writeFileSync(join(root, 'e2e', 'A', f), '// test'));
  return root;
};
const done = (scenarios: object[]) => ({ status: 'done', questions: [], plan: { summary: '계획', scenarios } });
const errorsOf = (scenarios: object[], withDesign: SavedDesign | null = null, root = workspace()) => {
  const r = checkQaPlan(done(scenarios), { spec, design: withDesign, root });
  return r.ok ? '' : r.errors.join('\n');
};

test('인수 조건을 모두 다루는 계획은 통과한다', () => {
  const r = checkQaPlan(done(apiPlan), { spec, design: null, root: workspace() });
  assert.ok(r.ok && r.kind === 'done');
  assert.equal(r.plan.scenarios.length, 3);
});

test('어느 시나리오도 다루지 않는 인수 조건이 있으면 거부한다', () => {
  assert.match(errorsOf(apiPlan.slice(0, 2)), /AC-3.*시나리오가 없습니다/);
});

test('스펙에 없는 인수 조건을 다룬다고 하면 거부한다', () => {
  assert.match(errorsOf([...apiPlan, scenario('S-9', { covers: ['AC-9'] })]), /AC-9/);
});

test('시나리오 ID가 겹치거나 절차·기대 결과가 비면 거부한다', () => {
  assert.match(errorsOf([...apiPlan, scenario('S-1')]), /S-1.*겹/);
  assert.match(errorsOf([...apiPlan.slice(1), scenario('S-1', { expected: ' ' })]), /expected/);
});

test('시나리오가 가리키는 테스트 파일이 실제로 E2E 폴더 안에 있어야 한다', () => {
  assert.match(errorsOf(apiPlan, null, workspace([])), /api\.test\.mjs.*없습니다/);
  assert.match(errorsOf([...apiPlan.slice(1), scenario('S-1', { file: 'src/app.test.mjs' })]), /e2e\/A/);
});

test('디자인이 없는데 화면 시나리오가 있으면 거부한다', () => {
  assert.match(errorsOf([...apiPlan, scenario('S-4', { target: 'screen', screen: '목록' })]), /디자인이 없는/);
});

test('디자인이 있으면: 화면 검사가 빠진 화면이 있으면 거부한다', () => {
  const missingEmpty = screenPlan.filter(s => s.screen !== '빈 목록').concat(scenario('S-2', { covers: ['AC-2'] }));
  assert.match(errorsOf(missingEmpty, design), /빈 목록.*화면 시나리오가 없습니다/);
});

test('디자인이 있으면: 화면에 드러나는 인수 조건은 화면에서 검사해야 한다', () => {
  // AC-2는 디자인의 "빈 목록" 화면이 다루는 조건인데, API로만 검사했다
  const apiOnly = screenPlan.map(s => (s.id === 'S-2' ? scenario('S-2', { covers: ['AC-2'] }) : s))
    .concat(scenario('S-5', { target: 'screen', screen: '빈 목록', covers: [], file: 'e2e/A/screen.test.mjs' }));
  assert.match(errorsOf(apiOnly, design), /AC-2.*화면에서 검사/);
});

test('디자인이 있으면: 디자인에 없는 화면 이름을 쓰면 거부한다', () => {
  assert.match(errorsOf([...screenPlan, scenario('S-9', { target: 'screen', screen: '설정', file: 'e2e/A/screen.test.mjs' })], design), /설정/);
});

test('디자인이 있으면: UX 기준에서 나온 시나리오가 하나는 있어야 한다', () => {
  assert.match(errorsOf(screenPlan.filter(s => s.basis !== 'ux'), design), /UX 기준/);
  assert.equal(errorsOf(screenPlan, design), '');
});

test('질문은 질문 목록과 함께 통과한다', () => {
  const r = checkQaPlan({ status: 'question', questions: ['서버는 어떻게 띄우나?'], plan: null }, { spec, design: null, root: workspace() });
  assert.ok(r.ok && r.kind === 'question');
});

test('사람이 읽을 계획은 인수 조건과 화면마다 어느 시나리오가 검사하는지 보여 준다', () => {
  const text = renderQaPlan({ summary: '계획', scenarios: screenPlan } as never, spec, design);
  assert.match(text, /AC-1.*S-1/);
  assert.match(text, /AC-3.*S-3/);
  assert.match(text, /빈 목록.*S-2/);
  assert.match(text, /키보드로 완료 버튼을 누른다/);
});

test('실패 증거에서 실행할 때마다 바뀌는 부분(색 코드, 시간, 작업 폴더 경로)을 지운다', () => {
  const a = normalizeEvidence('\u001b[31mnot ok 1 - AC-1\u001b[0m (12.5ms)\n  at /tmp/work-1/e2e/A/api.test.mjs:3\n# duration_ms 104.2\n2026-11-17T06:10:16.123Z fail', '/tmp/work-1');
  const b = normalizeEvidence('not ok 1 - AC-1 (9.1ms)\n  at /tmp/work-2/e2e/A/api.test.mjs:3\n# duration_ms 88\n2026-11-18T01:00:00.000Z fail', '/tmp/work-2');
  assert.equal(a, b);
  assert.match(a, /not ok 1 - AC-1/);
  assert.match(a, /e2e\/A\/api\.test\.mjs:3/);
});

test('실패 증거가 길면 끝부분만 남긴다', () => {
  const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const out = normalizeEvidence(long, '/x');
  assert.ok(out.split('\n').length <= 60);
  assert.match(out, /line 499/);
});

test('실패 증거는 실패한 테스트의 목록을 맨 앞에 둔다 (출력이 길어 잘려도 남는다)', () => {
  const detail = Array.from({ length: 200 }, (_, i) => `    at frame ${i}`).join('\n');
  const output = `Running 38 tests\n  1) S-5 날짜가 보인다\n${detail}\n  2 failed\n    e2e/UI-01/list.spec.mjs:63:3 › S-5 [AC-4] 날짜가 보인다\n    e2e/UI-01/list.spec.mjs:73:3 › S-6 [AC-4] 시간대\n  36 passed (6.6s)`;
  const out = normalizeEvidence(output, '/x');
  const first = out.split('\n')[0];
  assert.match(first, /2 failed/);
  assert.match(out.split('\n').slice(0, 4).join('\n'), /S-5 \[AC-4\].*\n.*S-6 \[AC-4\]/);
});

test('node:test 형식의 실패도 목록으로 모은다', () => {
  const out = normalizeEvidence('ok 1 - a\nnot ok 2 - AC-3 빈 배열\n  ---\n  error: x\nnot ok 3 - AC-4\n# fail 2', '/x');
  assert.equal(out.split('\n')[0], 'not ok 2 - AC-3 빈 배열');
  assert.equal(out.split('\n')[1], 'not ok 3 - AC-4');
});

test('실행 시간은 지우지만 설정값의 숫자는 남긴다', () => {
  const out = normalizeEvidence('Error: Test timeout of 30000ms exceeded.\n  ✘ S-1 목록 (1.2s)\n  ✘ S-2 날짜 (812ms)', '/x');
  assert.match(out, /Test timeout of 30000ms exceeded/);
  assert.doesNotMatch(out, /1\.2s|812ms/);
});

// ── 검증 명령이 직접 확인하는 인수 조건 ──

const withCommand = (scenarios: object[], byCommand: object[]) =>
  ({ status: 'done', questions: [], plan: { summary: '계획', scenarios, byCommand } });
const CMD = 'npx tsc -p . && npx vitest run';

test('검증 명령이 직접 확인한다고 표시한 인수 조건은 시나리오 없이도 다룬 것으로 본다', () => {
  const r = checkQaPlan(withCommand(apiPlan.slice(0, 2), [{ id: 'AC-3', reason: '검증 명령의 tsc가 타입 오류 0을 확인한다' }]),
    { spec, design: null, root: workspace(), command: CMD });
  assert.ok(r.ok && r.kind === 'done', r.ok ? '' : r.errors.join('\n'));
  assert.deepEqual(r.plan.byCommand, [{ id: 'AC-3', reason: '검증 명령의 tsc가 타입 오류 0을 확인한다' }]);
});

test('검증 명령이 설정되지 않았으면 검증 명령 표시를 받지 않는다', () => {
  const r = checkQaPlan(withCommand(apiPlan.slice(0, 2), [{ id: 'AC-3', reason: '이유' }]), { spec, design: null, root: workspace() });
  assert.ok(!r.ok);
  assert.match(r.errors.join('\n'), /검증 명령/);
});

test('검증 명령 표시에는 이유가 있어야 하고, 스펙에 있는 인수 조건이어야 한다', () => {
  const r = checkQaPlan(withCommand(apiPlan, [{ id: 'AC-3', reason: ' ' }, { id: 'AC-9', reason: '이유' }]),
    { spec, design: null, root: workspace(), command: CMD });
  assert.ok(!r.ok);
  const all = r.errors.join('\n');
  assert.match(all, /AC-3.*이유/);
  assert.match(all, /AC-9/);
});

test('화면에 드러나는 인수 조건은 검증 명령 표시로 대신할 수 없다', () => {
  const plan = screenPlan.filter(s => !(s.covers as string[]).includes('AC-1'));
  const r = checkQaPlan(withCommand(plan, [{ id: 'AC-1', reason: '이유' }]), { spec, design, root: workspace(), command: CMD });
  assert.ok(!r.ok);
  assert.match(r.errors.join('\n'), /AC-1/);
});

test('byCommand가 없는 예전 계획도 그대로 읽힌다', () => {
  const r = checkQaPlan(done(apiPlan), { spec, design: null, root: workspace(), command: CMD });
  assert.ok(r.ok && r.kind === 'done');
  assert.deepEqual(r.plan.byCommand ?? [], []);
});

test('사람이 읽을 계획에 검증 명령이 확인하는 인수 조건이 보인다', () => {
  const text = renderQaPlan({ summary: '계획', scenarios: apiPlan.slice(0, 2), byCommand: [{ id: 'AC-3', reason: 'tsc가 확인' }] } as never, spec, null);
  assert.match(text, /AC-3.*검증 명령/);
  assert.match(text, /tsc가 확인/);
});
