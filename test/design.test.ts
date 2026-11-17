import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDesignOutput, chooseSurface, connectedServers, designHash, readDesign, renderDesign, writeDesign } from '../src/design.ts';
import type { Exec } from '../src/agents/types.ts';
import type { SavedSpec } from '../src/spec.ts';

const CLAUDE_LIST = (extra = '') => `Checking MCP server health…

linear: https://mcp.linear.app/mcp (HTTP) - ✔ Connected
inflearn: https://mcp.inflearn.com/mcp (HTTP) - ! Needs authentication
aws-mcp: uvx mcp-proxy - ✘ Failed to connect — ENOENT
${extra}`;
const CODEX_LIST = (extra = '') => `Name     Command  Args  Env  Cwd  Status    Auth
rea      npx      -y    -    -    enabled   Unsupported
old      npx      -y    -    -    disabled  Unsupported
${extra}`;
/** 에이전트별 "mcp list" 출력을 흉내 낸다 */
const lists = (byAgent: Record<string, string>): Exec => async (command, args) => {
  assert.deepEqual(args, ['mcp', 'list']);
  return { code: 0, stdout: byAgent[command] ?? '', stderr: '', timedOut: false };
};

test('연결된 MCP 서버만 읽는다', () => {
  assert.deepEqual(connectedServers('claude', CLAUDE_LIST('Penpot: http://localhost:4401/mcp (HTTP) - ✔ Connected')), ['linear', 'Penpot']);
  assert.deepEqual(connectedServers('codex', CODEX_LIST('figma    npx      -y    -    -    enabled   OAuth')), ['rea', 'figma']);
});

test('도구 선택: penpot이 연결되어 있으면 penpot', async () => {
  const exec = lists({ claude: CLAUDE_LIST('penpot: x - ✔ Connected\nfigma: y - ✔ Connected') });
  assert.deepEqual(await chooseSurface('claude', exec), { surface: 'penpot', agent: 'claude', server: 'penpot' });
});

test('도구 선택: penpot이 없고 figma가 연결되어 있으면 figma', async () => {
  const exec = lists({ claude: CLAUDE_LIST('figma-dev-mode: y - ✔ Connected') });
  assert.deepEqual(await chooseSurface('claude', exec), { surface: 'figma', agent: 'claude', server: 'figma-dev-mode' });
});

test('도구 선택: 연결만 되어 있고 인증이 안 된 서버는 쓰지 않는다', async () => {
  const exec = lists({ claude: CLAUDE_LIST('penpot: x - ! Needs authentication') });
  assert.equal((await chooseSurface('claude', exec)).surface, 'html');
});

test('도구 선택: 둘 다 없으면 역할의 에이전트가 codex여도 claude로 HTML을 그린다', async () => {
  const exec = lists({ codex: CODEX_LIST(), claude: CLAUDE_LIST() });
  assert.deepEqual(await chooseSurface('codex', exec), { surface: 'html', agent: 'claude', server: null });
});

test('도구 선택: 역할의 에이전트에 연결된 도구를 먼저 쓰고, 없으면 claude 쪽 연결을 본다', async () => {
  const own = lists({ codex: CODEX_LIST('penpot   npx      -y    -    -    enabled   OAuth'), claude: CLAUDE_LIST() });
  assert.deepEqual(await chooseSurface('codex', own), { surface: 'penpot', agent: 'codex', server: 'penpot' });
  const other = lists({ codex: CODEX_LIST(), claude: CLAUDE_LIST('figma: y - ✔ Connected') });
  assert.deepEqual(await chooseSurface('codex', other), { surface: 'figma', agent: 'claude', server: 'figma' });
});

const spec = {
  id: 'A', reqHash: 'r', summary: 's', contract: 'c', policies: [], design: { needed: true, reason: '화면' },
  acceptance: [{ id: 'AC-1', given: 'g', when: 'w', then: 't' }, { id: 'AC-2', given: 'g', when: 'w', then: 't' }],
} satisfies SavedSpec;
const design = { summary: '목록 화면', location: 'https://design.penpot.app/#/view/1', screens: [{ name: '목록', description: '항목을 최신순으로 보여 준다', covers: ['AC-1'] }] };
const done = (override: object = {}) => ({ status: 'done', questions: [], design: { ...design, ...override } });
const workspace = (html?: string) => {
  const root = mkdtempSync(join(tmpdir(), 'agdd-design-'));
  if (html !== undefined) {
    mkdirSync(join(root, 'designs', 'A'), { recursive: true });
    writeFileSync(join(root, 'designs', 'A', 'index.html'), html);
  }
  return root;
};
const errorsOf = (output: unknown, surface: 'penpot' | 'figma' | 'html' = 'penpot', root = workspace()) => {
  const r = checkDesignOutput(output, { spec, surface, root });
  return r.ok ? '' : r.errors.join('\n');
};

test('올바른 디자인 출력은 통과한다', () => {
  const r = checkDesignOutput(done(), { spec, surface: 'penpot', root: workspace() });
  assert.ok(r.ok && r.kind === 'done');
  assert.equal(r.design.location, 'https://design.penpot.app/#/view/1');
});

test('질문은 질문 목록과 함께 통과한다', () => {
  const r = checkDesignOutput({ status: 'question', questions: ['빈 목록 문구는?'], design: null }, { spec, surface: 'html', root: workspace() });
  assert.ok(r.ok && r.kind === 'question');
});

test('화면이 없거나 화면 설명이 비면 거부한다', () => {
  assert.match(errorsOf(done({ screens: [] })), /화면/);
  assert.match(errorsOf(done({ screens: [{ name: '목록', description: ' ', covers: [] }] })), /description/);
});

test('스펙에 없는 인수 조건을 다뤘다고 하면 거부한다', () => {
  assert.match(errorsOf(done({ screens: [{ ...design.screens[0], covers: ['AC-9'] }] })), /AC-9/);
});

test('penpot·figma는 열어 볼 주소가 있어야 한다', () => {
  assert.match(errorsOf(done({ location: '그렸습니다' }), 'figma'), /주소/);
});

test('html은 약속한 자리에 HTML 파일이 실제로 있어야 하고, 위치는 코드가 정한다', () => {
  assert.match(errorsOf(done(), 'html', workspace()), /index\.html/);
  assert.match(errorsOf(done(), 'html', workspace('그냥 글')), /HTML/);
  const r = checkDesignOutput(done({ location: '아무 값' }), { spec, surface: 'html', root: workspace('<!doctype html><html><title>t</title></html>') });
  assert.ok(r.ok && r.kind === 'done');
  assert.equal(r.design.location, 'designs/A/index.html');
});

test('디자인을 저장하면 어느 스펙을 보고 그렸는지 남고, 해시는 폴더 내용이 바뀌면 달라진다', () => {
  const root = workspace('<!doctype html><html></html>');
  writeDesign(root, 'A', { ...design, surface: 'html', specHash: 'spec-h' });
  assert.equal(readDesign(root, 'A')?.specHash, 'spec-h');
  const before = designHash(root, 'A');
  writeFileSync(join(root, 'designs', 'A', 'index.html'), '<!doctype html><html><body>바뀜</body></html>');
  assert.notEqual(designHash(root, 'A'), before);
  assert.equal(designHash(root, 'none'), null);
});

test('사람이 읽을 디자인 요약은 위치와 화면, 다룬 인수 조건을 보여 준다', () => {
  const text = renderDesign({ ...design, surface: 'penpot', specHash: 'h' });
  assert.match(text, /penpot/);
  assert.match(text, /https:\/\/design\.penpot\.app/);
  assert.match(text, /목록.*AC-1/s);
});
