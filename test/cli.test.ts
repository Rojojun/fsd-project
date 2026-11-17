import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { specHash, writeSpec } from '../src/spec.ts';
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

const sampleSpec = {
  summary: '요약 문장', contract: '계약 내용',
  acceptance: [{ id: 'AC-1', given: 'g', when: 'w', then: '결과 문장' }],
  policies: [],
  design: { needed: false, reason: '화면 없음' },
};
/** 스펙 초안이 제출된 상태를 만든다: 스펙 파일 + 그 해시에 묶인 승인 대기 */
const draft = (root: string, id: string) => {
  writeSpec(root, { id, title: id, priority: 'P1', depends: [], policies: [], deprecated: false, body: 'b', hash: stateOf(root, id).reqHash }, sampleSpec);
  writeState(root, apply(stateOf(root, id), 'draftSpec', 'spec', { specHash: specHash(root, id)! }, at));
};

test('approve는 승인 대기 중인 스펙을 확정한다', () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  run(root, 'sync');
  draft(root, 'A-1');
  const r = run(root, 'approve', 'A-1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stateOf(root, 'A-1').status, 'specified');
  assert.equal(stateOf(root, 'A-1').approvedSpecHash, specHash(root, 'A-1'));
});

test('초안 제출 뒤 스펙 파일이 바뀌면 approve를 거부한다', () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  run(root, 'sync');
  draft(root, 'A-1');
  writeFileSync(join(root, 'specs', 'A-1', 'spec.json'), JSON.stringify({ ...sampleSpec, summary: '몰래 바꿈' }));
  const r = run(root, 'approve', 'A-1');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /해시/);
  assert.equal(stateOf(root, 'A-1').status, 'cataloged');
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

test('status는 상태 안의 세부 단계와 막고 있는 선행 요구사항을 보여 준다', () => {
  const root = workspace({
    'A-1.md': req('A-1'),
    'B-1.md': req('B-1').replace('priority: P1', 'priority: P1\ndepends: [A-1]'),
  });
  const out = run(root, 'status').stdout;
  assert.match(out, /A-1.*cataloged.*ready/);
  assert.match(out, /B-1.*cataloged.*blocked-by-dependency.*A-1/);
});

test('status --json은 요구사항별 상태와 플래그를 기계가 읽을 수 있게 내보낸다', () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  const r = run(root, 'status', '--json');
  assert.equal(r.status, 0, r.stderr);
  const [item] = JSON.parse(r.stdout);
  assert.equal(item.id, 'A-1');
  assert.equal(item.status, 'cataloged');
  assert.equal(item.flags.phase, 'ready');
  assert.equal(item.flags.rejections, 0);
});

test('반려가 한도에 닿으면 다음 명령에서 질문 대기가 붙어 노드 후보에서 빠진다', () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  run(root, 'sync');
  const reject = (s: RequirementState) =>
    apply(apply(s, 'draftSpec', 'spec', { specHash: 'h' }, at), 'reject', 'human', { reason: 'r' }, at);
  writeState(root, reject(reject(reject(stateOf(root, 'A-1')))));

  assert.match(run(root, 'next', 'spec').stdout, /후보가 없습니다/);
  const s = stateOf(root, 'A-1');
  assert.equal(s.holds[0]?.kind, 'question');
  assert.match(s.holds[0].message, /3회 반려/);
});

test('반복 한도는 agdd.config.json으로 바꿀 수 있다', () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  writeFileSync(join(root, 'agdd.config.json'), JSON.stringify({ limits: { rejections: 1 } }));
  run(root, 'sync');
  const s = stateOf(root, 'A-1');
  writeState(root, apply(apply(s, 'draftSpec', 'spec', { specHash: 'h' }, at), 'reject', 'human', { reason: 'r' }, at));
  run(root, 'status');
  assert.equal(stateOf(root, 'A-1').holds[0]?.kind, 'question');
});

// ── tick: PATH에 가짜 claude/codex 실행 파일을 두고 실제로 프로세스를 띄운다 ──

const fakeBin = (root: string, name: string, stdout: string, exitCode = 0) => {
  const bin = join(root, '.fake-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, `${name}.out`), stdout);
  writeFileSync(join(bin, name), `#!/bin/sh\ncat "$(dirname "$0")/${name}.out"\nexit ${exitCode}\n`);
  chmodSync(join(bin, name), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
};
const runEnv = (root: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', env });
const claudeOut = (structured: unknown) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.05, structured_output: structured, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { 'fake-model': {} } });
const codexOut = (structured: unknown) =>
  [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(structured) } }, { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }]
    .map(e => JSON.stringify(e)).join('\n');

test('tick spec: 에이전트가 질문하면 질문 대기가 붙고 실행 기록이 남는다', () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  const env = fakeBin(root, 'claude', claudeOut({ status: 'question', questions: ['정렬 방향은?'], spec: null }));
  const r = runEnv(root, env, 'tick', 'spec');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /A-1.*정렬 방향은\?/s);
  assert.equal(stateOf(root, 'A-1').holds[0].message, '정렬 방향은?');
  const [log] = readdirSync(join(root, '.agdd', 'runs'));
  const record = JSON.parse(readFileSync(join(root, '.agdd', 'runs', log), 'utf8'));
  assert.deepEqual([record.node, record.id, record.agent, record.outcome, record.usage.costUsd], ['spec', 'A-1', 'claude', 'question', 0.05]);
});

test('tick spec --agent codex: 초안이 저장되고 show로 읽은 뒤 approve로 확정한다', () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  const env = fakeBin(root, 'codex', codexOut({ status: 'done', questions: [], spec: sampleSpec }));
  const r = runEnv(root, env, 'tick', 'spec', '--agent', 'codex');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stateOf(root, 'A-1').holds[0].kind, 'approval');

  const shown = run(root, 'show', 'A-1').stdout;
  assert.match(shown, /요약 문장/);
  assert.match(shown, /AC-1/);
  assert.match(shown, /승인 대기/);

  assert.equal(run(root, 'approve', 'A-1').status, 0);
  assert.equal(stateOf(root, 'A-1').status, 'specified');
});

test('tick spec: 설정의 역할별 에이전트를 쓴다', () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  writeFileSync(join(root, 'agdd.config.json'), JSON.stringify({ roles: { 'spec-writer': { agent: 'codex' } } }));
  const env = fakeBin(root, 'codex', codexOut({ status: 'question', questions: ['Q'], spec: null }));
  assert.equal(runEnv(root, env, 'tick', 'spec').status, 0);
  assert.equal(stateOf(root, 'A-1').holds[0].kind, 'question');
});

test('tick spec: 에이전트가 실패하면 상태를 바꾸지 않고 실패로 끝나며 기록은 남긴다', () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  const env = fakeBin(root, 'claude', 'boom', 3);
  const r = runEnv(root, env, 'tick', 'spec');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /에이전트 실패/);
  assert.deepEqual(stateOf(root, 'A-1').holds, []);
  assert.equal(readdirSync(join(root, '.agdd', 'runs')).length, 1);
});

test('tick spec: 후보가 없으면 에이전트를 부르지 않고 정상 종료한다', () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  const env = fakeBin(root, 'claude', claudeOut({ status: 'question', questions: ['Q'], spec: null }));
  runEnv(root, env, 'tick', 'spec');
  const r = runEnv(root, env, 'tick', 'spec');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /후보가 없습니다/);
  assert.equal(readdirSync(join(root, '.agdd', 'runs')).length, 1);
});

test('tick: 모르는 에이전트 이름은 거부한다', () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  const r = run(root, 'tick', 'spec', '--agent', 'nope');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nope/);
});

test('요구사항이 인용한 정책 파일이 없으면 중단한다', () => {
  const root = workspace({ 'A-1.md': req('A-1').replace('priority: P1', 'priority: P1\npolicies: [missing-policy]') });
  const r = run(root, 'status');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing-policy/);
});

test('status 표는 질문이 길고 여러 줄이어도 요구사항당 한 줄이다', () => {
  const root = workspace({ 'A-1.md': req('A-1'), 'B-1.md': req('B-1') });
  run(root, 'sync');
  writeState(root, apply(stateOf(root, 'A-1'), 'ask', 'spec', { question: `1) ${'긴 질문 '.repeat(40)}\n2) 둘째 질문` }, at));
  const lines = run(root, 'status').stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /질문 대기 Q\d+\(spec\)/);
  assert.ok(lines.every(l => l.length < 120), '줄이 너무 깁니다');
  assert.match(run(root, 'show', 'A-1').stdout, /둘째 질문/);
});
