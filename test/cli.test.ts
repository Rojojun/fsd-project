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
  writeSpec(root, { id, title: id, priority: 'P1', depends: [], policies: [], design: null, deprecated: false, body: 'b', hash: stateOf(root, id).reqHash }, sampleSpec);
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

// ── 디자인 루프 ──

const uiSpec = { ...sampleSpec, design: { needed: true, reason: '목록 화면이 새로 생긴다' } };
/** 스펙 초안(디자인 필요)이 제출된 작업 폴더 */
const draftedUi = (frontExtra = '') => {
  const root = workspace({ 'A-1.md': req('A-1').replace('priority: P1', `priority: P1${frontExtra}`) });
  run(root, 'sync');
  writeSpec(root, { id: 'A-1', title: 'A-1', priority: 'P1', depends: [], policies: [], design: null, deprecated: false, body: 'b', hash: stateOf(root, 'A-1').reqHash }, uiSpec);
  writeState(root, apply(stateOf(root, 'A-1'), 'draftSpec', 'spec', { specHash: specHash(root, 'A-1')! }, at));
  mkdirSync(join(root, 'design'));
  writeFileSync(join(root, 'design', 'ui.md'), '# UI 기준\n\n- 색은 변수로 정한다\n');
  writeFileSync(join(root, 'design', 'ux.md'), '# UX 기준\n\n- 빈 상태를 빠뜨리지 않는다\n');
  return root;
};
const designOut = (location: string, codified: object[] = []) => ({
  status: 'done', questions: [],
  design: { summary: '목록 화면 디자인', location, screens: [{ name: '목록', description: '빈 상태 포함', covers: ['AC-1'] }], codified },
});
/**
 * `mcp list`에는 서버 목록을, 그 밖의 호출에는 정해진 결과를 내는 가짜 에이전트.
 * 받은 인자를 <이름>.args에 남기고, drawsHtml이면 실제 에이전트처럼 디자인 파일을 쓴다.
 */
const fakeDesigner = (root: string, name: string, opts: { mcpList?: string; stdout?: string; drawsHtml?: boolean }) => {
  const bin = join(root, '.fake-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, `${name}.mcp`), opts.mcpList ?? '');
  writeFileSync(join(bin, `${name}.out`), opts.stdout ?? '');
  const draw = opts.drawsHtml ? 'mkdir -p designs/A-1 && printf "<!doctype html><html><title>목록</title></html>" > designs/A-1/index.html\n' : '';
  writeFileSync(join(bin, name), `#!/bin/sh\nd="$(dirname "$0")"\nif [ "$1" = "mcp" ]; then cat "$d/${name}.mcp"; exit 0; fi\necho "$@" > "$d/${name}.args"\n${draw}cat "$d/${name}.out"\n`);
  chmodSync(join(bin, name), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
};
const argsOf = (root: string, name: string) => readFileSync(join(root, '.fake-bin', `${name}.args`), 'utf8');
const lastRun = (root: string) => {
  const dir = join(root, '.agdd', 'runs');
  return JSON.parse(readFileSync(join(dir, readdirSync(dir).sort().at(-1)!), 'utf8'));
};

test('디자인이 필요한 스펙을 승인하면 design 후보가 되고 dev 후보에서는 빠진다', () => {
  const root = draftedUi();
  assert.equal(run(root, 'approve', 'A-1').status, 0);
  assert.equal(stateOf(root, 'A-1').designRequired, true);
  assert.match(run(root, 'next', 'design').stdout, /A-1/);
  assert.match(run(root, 'next', 'dev').stdout, /후보가 없습니다/);
});

test('요구사항 머리말의 design: false는 spec 노드의 판단보다 우선한다', () => {
  const root = draftedUi('\ndesign: false');
  // 머리말을 고쳤으므로 초안을 다시 제출한 상태로 만든다
  writeSpec(root, { id: 'A-1', title: 'A-1', priority: 'P1', depends: [], policies: [], design: false, deprecated: false, body: 'b', hash: stateOf(root, 'A-1').reqHash }, uiSpec);
  writeState(root, apply({ ...stateOf(root, 'A-1'), holds: [] }, 'draftSpec', 'spec', { specHash: specHash(root, 'A-1')! }, at));
  assert.equal(run(root, 'approve', 'A-1').status, 0);
  assert.equal(stateOf(root, 'A-1').designRequired, false);
  assert.match(run(root, 'next', 'dev').stdout, /A-1/);
});

test('tick design: 디자인 도구가 없으면 claude가 HTML로 그리고 승인 대기가 붙는다', () => {
  const root = draftedUi();
  run(root, 'approve', 'A-1');
  const env = fakeDesigner(root, 'claude', { mcpList: 'linear: x - ✔ Connected', stdout: claudeOut(designOut('x')), drawsHtml: true });
  const r = runEnv(root, env, 'tick', 'design');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /A-1.*승인 대기/s);
  const s = stateOf(root, 'A-1');
  assert.deepEqual([s.status, s.holds[0].kind, s.holds[0].raisedBy], ['specified', 'approval', 'design']);
  const saved = JSON.parse(readFileSync(join(root, 'designs', 'A-1', 'design.json'), 'utf8'));
  assert.deepEqual([saved.surface, saved.location], ['html', 'designs/A-1/index.html']);
  assert.deepEqual([lastRun(root).node, lastRun(root).agent, lastRun(root).surface], ['design', 'claude', 'html']);
  assert.doesNotMatch(argsOf(root, 'claude'), /Bash/);
});

test('tick design: penpot이 연결되어 있으면 penpot에 그리게 하고 주소를 저장한다', () => {
  const root = draftedUi();
  run(root, 'approve', 'A-1');
  const env = fakeDesigner(root, 'claude', {
    mcpList: 'figma: y - ✔ Connected\npenpot: x - ✔ Connected',
    stdout: claudeOut(designOut('https://design.penpot.app/#/view/1')),
  });
  const r = runEnv(root, env, 'tick', 'design');
  assert.equal(r.status, 0, r.stderr);
  const saved = JSON.parse(readFileSync(join(root, 'designs', 'A-1', 'design.json'), 'utf8'));
  assert.deepEqual([saved.surface, saved.location], ['penpot', 'https://design.penpot.app/#/view/1']);
  assert.match(argsOf(root, 'claude'), /mcp__penpot/);
  assert.doesNotMatch(argsOf(root, 'claude'), /Edit|Write/);
});

test('tick design: 역할의 에이전트가 codex여도 디자인 도구가 없으면 claude를 부른다', () => {
  const root = draftedUi();
  writeFileSync(join(root, 'agdd.config.json'), JSON.stringify({ roles: { designer: { agent: 'codex' } } }));
  run(root, 'approve', 'A-1');
  fakeDesigner(root, 'codex', { mcpList: 'Name  Status\nrea   enabled' });
  const env = fakeDesigner(root, 'claude', { stdout: claudeOut(designOut('x')), drawsHtml: true });
  const r = runEnv(root, env, 'tick', 'design');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lastRun(root).agent, 'claude');
  assert.equal(existsSync(join(root, '.fake-bin', 'codex.args')), false, 'codex로 그리면 안 된다');
});

test('tick design: 디자인이 필요한 요구사항이 없으면 도구 확인도 에이전트 호출도 하지 않는다', () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  run(root, 'sync');
  draft(root, 'A-1');
  run(root, 'approve', 'A-1');
  const env = fakeDesigner(root, 'claude', { mcpList: '', stdout: 'should not run' });
  writeFileSync(join(root, '.fake-bin', 'claude'), '#!/bin/sh\necho called > "$(dirname "$0")/called"\nexit 9\n');
  const r = runEnv(root, env, 'tick', 'design');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /후보가 없습니다/);
  assert.equal(existsSync(join(root, '.fake-bin', 'called')), false);
});

test('디자인 초안은 show로 읽고 approve로 확정하며, 그 뒤에야 dev 후보가 된다', () => {
  const root = draftedUi();
  run(root, 'approve', 'A-1');
  const env = fakeDesigner(root, 'claude', { stdout: claudeOut(designOut('x')), drawsHtml: true });
  runEnv(root, env, 'tick', 'design');
  const shown = run(root, 'show', 'A-1').stdout;
  assert.match(shown, /목록 화면 디자인/);
  assert.match(shown, /designs\/A-1\/index\.html/);
  assert.match(shown, /디자인 초안 \(미승인\)/);

  const r = run(root, 'approve', 'A-1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stateOf(root, 'A-1').status, 'designed');
  assert.match(run(root, 'next', 'dev').stdout, /A-1/);
});

test('디자인 초안 제출 뒤 디자인 파일이 바뀌면 approve를 거부한다', () => {
  const root = draftedUi();
  run(root, 'approve', 'A-1');
  runEnv(root, fakeDesigner(root, 'claude', { stdout: claudeOut(designOut('x')), drawsHtml: true }), 'tick', 'design');
  writeFileSync(join(root, 'designs', 'A-1', 'index.html'), '<!doctype html><html>몰래 바꿈</html>');
  const r = run(root, 'approve', 'A-1');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /해시/);
  assert.equal(stateOf(root, 'A-1').status, 'specified');
});

// ── 디자인 언어, 두 관점의 검토, 지적의 명문화 ──

const htmlDesigner = (root: string, codified: object[] = []) =>
  fakeDesigner(root, 'claude', { stdout: claudeOut(designOut('x', codified)), drawsHtml: true });

test('tick design: 디자인 언어 문서가 없으면 그리지 않고 spec 단계로 되돌린다', () => {
  const root = draftedUi();
  run(root, 'approve', 'A-1');
  writeFileSync(join(root, 'design', 'ux.md'), '# UX 기준\n');
  const env = htmlDesigner(root);
  const r = runEnv(root, env, 'tick', 'design');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /되돌림.*design\/ux\.md/s);
  assert.equal(stateOf(root, 'A-1').status, 'stale');
  assert.equal(existsSync(join(root, '.fake-bin', 'claude.args')), false, '에이전트를 부르면 안 된다');
  assert.match(run(root, 'status').stdout, /stale.*design-returned/);
  assert.match(run(root, 'next', 'spec').stdout, /A-1/);
});

test('디자인 검토는 --ui와 --ux로 따로 승인하고, 둘 다 승인되어야 designed가 된다', () => {
  const root = draftedUi();
  run(root, 'approve', 'A-1');
  runEnv(root, htmlDesigner(root), 'tick', 'design');
  assert.match(run(root, 'status').stdout, /UI 대기.*UX 대기/);

  assert.equal(run(root, 'approve', 'A-1', '--ui').status, 0);
  assert.equal(stateOf(root, 'A-1').status, 'specified');
  assert.match(run(root, 'status').stdout, /UI 승인.*UX 대기/);
  assert.match(run(root, 'next', 'dev').stdout, /후보가 없습니다/);

  assert.equal(run(root, 'approve', 'A-1', '--ux').status, 0);
  assert.equal(stateOf(root, 'A-1').status, 'designed');
});

test('reject --ux는 UX 관점의 지적으로 남고, status에 어느 관점에서 반려됐는지 보인다', () => {
  const root = draftedUi();
  run(root, 'approve', 'A-1');
  runEnv(root, htmlDesigner(root), 'tick', 'design');
  const r = run(root, 'reject', 'A-1', '끝났는지 모르겠다', '--ux');
  assert.equal(r.status, 0, r.stderr);
  const last = stateOf(root, 'A-1').feedback.at(-1)!;
  assert.deepEqual([last.message, last.about, last.aspect], ['끝났는지 모르겠다', 'design', 'ux']);
  assert.match(run(root, 'status').stdout, /redraft.*UX 반려/);
});

test('디자인이 승인되면 명문화된 일반 규칙이 디자인 언어 문서에 쌓인다', () => {
  const root = draftedUi();
  run(root, 'approve', 'A-1');
  runEnv(root, htmlDesigner(root), 'tick', 'design');
  run(root, 'reject', 'A-1', '답답해 보인다', '--ui');
  const codified = [{ aspect: 'ui', source: '답답해 보인다', rule: '목록 줄 사이 간격은 12px 이상으로 한다', scope: 'language' }];
  const again = runEnv(root, htmlDesigner(root, codified), 'tick', 'design');
  assert.equal(again.status, 0, again.stderr);
  assert.match(run(root, 'show', 'A-1').stdout, /답답해 보인다.*목록 줄 사이 간격은 12px 이상/s);
  assert.doesNotMatch(readFileSync(join(root, 'design', 'ui.md'), 'utf8'), /12px/, '승인 전에는 쌓이지 않는다');

  run(root, 'approve', 'A-1', '--ui');
  const r = run(root, 'approve', 'A-1', '--ux');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /디자인 언어.*1/s);
  assert.match(readFileSync(join(root, 'design', 'ui.md'), 'utf8'), /목록 줄 사이 간격은 12px 이상으로 한다 \(출처: A-1/);
});

// ── dev, verify ──

/** 프롬프트에 든 표시에 따라 다른 답을 내는 가짜 에이전트. before는 답하기 전에 작업 폴더에서 실행할 셸 명령. */
const fakeByPrompt = (root: string, name: string, cases: { marker: string; stdout: string }[], before = '') => {
  const bin = join(root, '.fake-bin');
  mkdirSync(bin, { recursive: true });
  cases.forEach((c, i) => writeFileSync(join(bin, `${name}.${i}.out`), c.stdout));
  const branches = cases.map((c, i) => `  *${c.marker}*) echo ${i} >> "$d/${name}.calls"; cat "$d/${name}.${i}.out";;`).join('\n');
  writeFileSync(join(bin, name), `#!/bin/sh\nd="$(dirname "$0")"\nif [ "$1" = "mcp" ]; then exit 0; fi\n${before}\ncase "$*" in\n${branches}\nesac\n`);
  chmodSync(join(bin, name), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
};
const devOut = (files: string[], summary: string) => claudeOut({ status: 'done', questions: [], summary, files, notes: '' });
/** 스펙이 확정된(디자인 불필요) 작업 폴더 */
const specifiedApi = () => {
  const root = workspace({ 'A-1.md': req('A-1') });
  run(root, 'sync');
  draft(root, 'A-1');
  run(root, 'approve', 'A-1');
  return root;
};
const qaOut = claudeOut({
  status: 'done', questions: [],
  plan: { summary: 'API 검사 계획', scenarios: [{ id: 'S-1', target: 'api', screen: '', covers: ['AC-1'], basis: 'acceptance', title: '결과 확인', steps: '요청한다', expected: '결과 문장', file: 'e2e/A-1/api.test.mjs' }] },
});
const WRITE_TEST = 'mkdir -p e2e/A-1 && echo "// AC-1" > e2e/A-1/api.test.mjs';
const verifyConfig = (root: string, command: string) =>
  writeFileSync(join(root, 'agdd.config.json'), JSON.stringify({ verify: { command } }));

test('tick dev: 디자인이 없는 요구사항은 에이전트 하나가 구현하고 implemented가 된다', () => {
  const root = specifiedApi();
  const env = fakeByPrompt(root, 'claude', [{ marker: '', stdout: devOut(['app/tasks.mjs'], '목록 조회를 구현함') }]);
  const r = runEnv(root, env, 'tick', 'dev');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /A-1.*구현 완료.*목록 조회를 구현함/s);
  assert.equal(stateOf(root, 'A-1').status, 'implemented');
  assert.deepEqual([lastRun(root).node, lastRun(root).outcome], ['dev', 'implemented']);
  assert.match(run(root, 'next', 'verify').stdout, /A-1/);
});

test('tick dev: 디자인이 있으면 백엔드와 프론트엔드 에이전트를 따로 부르고 호출 기록도 둘이다', () => {
  const root = draftedUi();
  run(root, 'approve', 'A-1');
  runEnv(root, htmlDesigner(root), 'tick', 'design');
  run(root, 'approve', 'A-1');
  assert.equal(stateOf(root, 'A-1').status, 'designed');
  mkdirSync(join(root, 'skills'));
  for (const name of ['dev', 'dev-backend', 'dev-frontend']) writeFileSync(join(root, 'skills', `${name}.md`), `MARK-${name.toUpperCase()}`);

  const env = fakeByPrompt(root, 'claude', [
    { marker: 'MARK-DEV-FRONTEND', stdout: devOut(['web/list.html'], '화면을 구현함') },
    { marker: 'MARK-DEV-BACKEND', stdout: devOut(['server/tasks.mjs'], 'API를 구현함') },
  ]);
  const r = runEnv(root, env, 'tick', 'dev');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /백엔드.*API를 구현함/s);
  assert.match(r.stdout, /프론트엔드.*화면을 구현함/s);
  assert.equal(stateOf(root, 'A-1').status, 'implemented');
  assert.deepEqual(readFileSync(join(root, '.fake-bin', 'claude.calls'), 'utf8').trim().split('\n').sort(), ['0', '1']);
  const nodes = readdirSync(join(root, '.agdd', 'runs')).filter(f => f.includes('-dev-')).map(f => JSON.parse(readFileSync(join(root, '.agdd', 'runs', f), 'utf8')).node).sort();
  assert.deepEqual(nodes, ['dev-backend', 'dev-frontend']);
});

test('tick verify: E2E 실행 명령이 설정에 없으면 안내하고 실패한다', () => {
  const root = specifiedApi();
  runEnv(root, fakeByPrompt(root, 'claude', [{ marker: '', stdout: devOut(['a'], 's') }]), 'tick', 'dev');
  const r = run(root, 'tick', 'verify');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /verify.*command/s);
  assert.equal(stateOf(root, 'A-1').status, 'implemented');
});

test('tick verify: QA가 계획과 테스트를 쓰고 설정된 명령이 통과하면 verified가 된다', () => {
  const root = specifiedApi();
  runEnv(root, fakeByPrompt(root, 'claude', [{ marker: '', stdout: devOut(['a'], 's') }]), 'tick', 'dev');
  verifyConfig(root, 'test -f e2e/{id}/api.test.mjs');
  const r = runEnv(root, fakeByPrompt(root, 'claude', [{ marker: '', stdout: qaOut }], WRITE_TEST), 'tick', 'verify');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /A-1.*검증 완료/s);
  assert.equal(stateOf(root, 'A-1').status, 'verified');
  const shown = run(root, 'show', 'A-1').stdout;
  assert.match(shown, /검사 계획/);
  assert.match(shown, /AC-1.*S-1/);
});

test('tick verify: 명령이 실패하면 증거와 함께 dev로 되돌리고, 다음 dev가 그 버그를 집는다', () => {
  const root = specifiedApi();
  runEnv(root, fakeByPrompt(root, 'claude', [{ marker: '', stdout: devOut(['a'], 's') }]), 'tick', 'dev');
  verifyConfig(root, 'echo "not ok 1 - AC-1 빈 배열이 아님"; exit 1');
  const r = runEnv(root, fakeByPrompt(root, 'claude', [{ marker: '', stdout: qaOut }], WRITE_TEST), 'tick', 'verify');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /A-1.*E2E 실패.*not ok 1 - AC-1/s);
  const s = stateOf(root, 'A-1');
  assert.equal(s.status, 'in-dev');
  assert.match(s.bug!.evidence, /not ok 1 - AC-1 빈 배열이 아님/);
  assert.match(run(root, 'status').stdout, /in-dev.*rework/);
  assert.match(run(root, 'next', 'dev').stdout, /A-1/);
});
