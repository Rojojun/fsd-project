import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSpecOutput, readSpec, renderSpec, specHash, writeSpec } from '../src/spec.ts';
import type { RequirementDoc } from '../src/model.ts';

const doc: RequirementDoc = {
  id: 'A-1', title: '목록 조회', priority: 'P0', depends: [], policies: ['newest-first'],
  deprecated: false, body: 'b', hash: 'req-h',
};
const spec = {
  summary: '목록을 최신순으로 돌려준다.',
  contract: '`GET /tasks` → 200, JSON 배열',
  acceptance: [
    { id: 'AC-1', given: '항목이 둘 있을 때', when: 'GET /tasks', then: '최신 항목이 먼저 온다' },
    { id: 'AC-2', given: '항목이 없을 때', when: 'GET /tasks', then: '빈 배열을 돌려준다' },
  ],
  policies: [{ id: 'newest-first', applied: '정렬 방향을 내림차순으로 정했다' }],
};
const done = (override: object = {}) => ({ status: 'done', questions: [], spec: { ...spec, ...override } });
const errorsOf = (output: unknown) => {
  const r = checkSpecOutput(output, doc);
  return r.ok ? '' : r.errors.join('\n');
};

test('올바른 스펙은 통과한다', () => {
  const r = checkSpecOutput(done(), doc);
  assert.ok(r.ok && r.kind === 'done');
  assert.equal(r.spec.acceptance.length, 2);
});

test('질문은 질문 목록과 함께 통과한다', () => {
  const r = checkSpecOutput({ status: 'question', questions: ['정렬 방향은?'], spec: null }, doc);
  assert.ok(r.ok && r.kind === 'question');
  assert.deepEqual(r.questions, ['정렬 방향은?']);
});

test('질문이라면서 질문이 비어 있으면 거부한다', () => {
  assert.match(errorsOf({ status: 'question', questions: [], spec: null }), /질문/);
});

test('완료라면서 질문이 남아 있으면 거부한다', () => {
  assert.match(errorsOf({ ...done(), questions: ['이건 어떻게?'] }), /질문/);
});

test('인수 조건이 없으면 거부한다', () => {
  assert.match(errorsOf(done({ acceptance: [] })), /인수 조건/);
});

test('인수 조건 ID가 겹치거나 항목이 비면 거부한다', () => {
  const dup = [spec.acceptance[0], { ...spec.acceptance[1], id: 'AC-1' }];
  assert.match(errorsOf(done({ acceptance: dup })), /AC-1.*겹/);
  assert.match(errorsOf(done({ acceptance: [{ ...spec.acceptance[0], then: ' ' }] })), /then/);
});

test('요구사항이 근거로 든 정책을 스펙이 다루지 않으면 거부한다', () => {
  assert.match(errorsOf(done({ policies: [] })), /newest-first/);
});

test('요구사항에 없는 정책을 인용하면 거부한다', () => {
  const extra = [...spec.policies, { id: 'made-up', applied: 'x' }];
  assert.match(errorsOf(done({ policies: extra })), /made-up/);
});

test('형식이 아예 다른 출력은 거부한다', () => {
  assert.match(errorsOf('그냥 문자열'), /형식/);
  assert.match(errorsOf({ status: 'maybe' }), /status/);
  assert.match(errorsOf({ status: 'done', questions: [], spec: null }), /spec/);
});

test('스펙 파일을 쓰고 읽으면 같은 내용이고 요구사항 지문을 함께 남긴다', () => {
  const root = mkdtempSync(join(tmpdir(), 'agdd-spec-'));
  writeSpec(root, doc, spec);
  const saved = readSpec(root, 'A-1');
  assert.equal(saved?.reqHash, 'req-h');
  assert.deepEqual(saved?.acceptance, spec.acceptance);
});

test('스펙 해시는 스펙 폴더의 파일 내용이 바뀌면 달라진다', () => {
  const root = mkdtempSync(join(tmpdir(), 'agdd-spec-'));
  assert.equal(specHash(root, 'A-1'), null);
  writeSpec(root, doc, spec);
  const before = specHash(root, 'A-1');
  assert.equal(specHash(root, 'A-1'), before);
  writeFileSync(join(root, 'specs', 'A-1', 'e2e.test.mjs'), '// 나중에 추가된 파일');
  assert.notEqual(specHash(root, 'A-1'), before);
});

test('사람이 읽을 스펙 문서는 인수 조건을 ID와 함께 보여 준다', () => {
  const text = renderSpec(spec);
  assert.match(text, /AC-1/);
  assert.match(text, /최신 항목이 먼저 온다/);
  assert.match(text, /newest-first/);
});
