import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../src/transitions.ts';
import type { RequirementState } from '../src/model.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const at = '2026-11-17T00:00:00Z';

const workspace = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'agdd-'));
  mkdirSync(join(root, 'requirements'));
  Object.entries(files).forEach(([name, text]) => writeFileSync(join(root, 'requirements', name), text));
  return root;
};
const req = (id: string, priority = 'P1') => `---\nid: ${id}\ntitle: ${id} 제목\npriority: ${priority}\n---\n${id} 본문\n`;
const run = (root: string, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
const stateOf = (root: string, id: string): RequirementState =>
  JSON.parse(readFileSync(join(root, '.agdd', 'state', `${id}.json`), 'utf8'));
const writeState = (root: string, s: RequirementState) =>
  writeFileSync(join(root, '.agdd', 'state', `${s.id}.json`), JSON.stringify(s));

test('status는 sync 후 요구사항별 상태를 보여 주고 상태 파일을 남긴다', () => {
  const root = workspace({ 'A-1.md': req('A-1', 'P0') });
  const r = run(root, 'status');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /A-1.*P0.*cataloged/);
  assert.equal(stateOf(root, 'A-1').status, 'cataloged');
});

test('요구사항 파일 하나라도 잘못되면 아무 상태도 바꾸지 않고 실패한다', () => {
  const root = workspace({ 'A-1.md': req('A-1'), 'B-1.md': 'no front matter' });
  const r = run(root, 'status');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /B-1\.md/);
  assert.equal(existsSync(join(root, '.agdd', 'state', 'A-1.json')), false);
});

test('next는 노드가 고를 후보를 보여 준다', () => {
  const root = workspace({ 'A-1.md': req('A-1', 'P1'), 'B-1.md': req('B-1', 'P0') });
  const r = run(root, 'next', 'spec');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /B-1/);
});

test('answer는 열린 질문을 닫고 결정을 기록한다', () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  run(root, 'sync');
  writeState(root, apply(stateOf(root, 'A-1'), 'ask', 'spec', { question: '정렬 방향은?' }, at));
  assert.match(run(root, 'status').stdout, /질문 대기/);

  const r = run(root, 'answer', 'A-1', 'desc');
  assert.equal(r.status, 0, r.stderr);
  const s = stateOf(root, 'A-1');
  assert.deepEqual(s.holds, []);
  assert.equal(s.decisions.at(-1)?.answer, 'desc');
});

test('approve는 승인 대기 중인 스펙을 확정한다', () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  run(root, 'sync');
  writeState(root, apply(stateOf(root, 'A-1'), 'draftSpec', 'spec', { specHash: 'spec-h' }, at));
  const r = run(root, 'approve', 'A-1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stateOf(root, 'A-1').status, 'specified');
  assert.equal(stateOf(root, 'A-1').approvedSpecHash, 'spec-h');
});

test('규칙에 없는 명령은 이유와 함께 실패하고 상태를 바꾸지 않는다', () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  run(root, 'sync');
  const before = stateOf(root, 'A-1');
  const r = run(root, 'approve', 'A-1');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /승인 대기/);
  assert.deepEqual(stateOf(root, 'A-1'), before);
});

test('요구사항 파일을 고치면 다음 명령에서 바로 반영된다', () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  run(root, 'sync');
  writeState(root, apply(stateOf(root, 'A-1'), 'draftSpec', 'spec', { specHash: 'spec-h' }, at));
  writeFileSync(join(root, 'requirements', 'A-1.md'), req('A-1').replace('본문', '바뀐 본문'));
  const r = run(root, 'approve', 'A-1');
  assert.equal(r.status, 1, '요구사항이 바뀌어 초안이 폐기됐으므로 승인할 수 없어야 한다');
  assert.deepEqual(stateOf(root, 'A-1').holds, []);
});

test('requirements 폴더가 없으면 안내와 함께 실패한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'agdd-'));
  const r = run(root, 'status');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requirements/);
  assert.doesNotMatch(r.stderr, /ENOENT|at /);
});
