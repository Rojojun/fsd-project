import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { claudeAgent } from '../src/agents/claude.ts';
import { codexAgent } from '../src/agents/codex.ts';
import type { AgentTask, Exec, ExecResult } from '../src/agents/types.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const task: AgentTask = {
  prompt: '스펙을 써라',
  schema: { type: 'object' },
  cwd: '/work',
  access: 'read-only',
  timeoutMs: 1000,
  maxTurns: 7,
};
const done = (stdout: string, extra: Partial<ExecResult> = {}): ExecResult => ({
  code: 0, stdout, stderr: '', timedOut: false, ...extra,
});
/** 실제 프로세스 대신 정해진 결과를 돌려주고 호출 내용을 기록한다 */
const fakeExec = (result: ExecResult) => {
  const calls: { command: string; args: readonly string[]; cwd: string; timeoutMs: number }[] = [];
  const exec: Exec = async (command, args, options) => {
    calls.push({ command, args, ...options });
    return result;
  };
  return { exec, calls };
};

test('claude: 구조화 출력을 결과로 돌려주고 비용·턴·모델을 정규화한다', async () => {
  const { exec } = fakeExec(done(fixture('claude-question.json')));
  const r = await claudeAgent(exec)(task);
  assert.ok(r.ok);
  assert.equal((r.output as { status: string }).status, 'question');
  assert.equal(r.agent, 'claude');
  assert.equal(r.model, 'claude-opus-5-5');
  assert.equal(r.usage.costUsd, 0.3410736);
  assert.equal(r.usage.turns, 3);
  assert.equal(r.usage.outputTokens, 450);
});

test('claude: 턴 한도 초과는 turn-limit 실패다', async () => {
  const { exec } = fakeExec(done(fixture('claude-max-turns.json'), { code: 1 }));
  const r = await claudeAgent(exec)(task);
  assert.ok(!r.ok);
  assert.equal(r.reason, 'turn-limit');
  assert.equal(r.usage.costUsd, 0.010578);
});

test('claude: 읽기 전용 과제는 읽기 도구만 허용하고 과제의 한도와 작업 폴더를 넘긴다', async () => {
  const { exec, calls } = fakeExec(done(fixture('claude-question.json')));
  await claudeAgent(exec)(task);
  const [{ command, args, cwd, timeoutMs }] = calls;
  const valueOf = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(command, 'claude');
  assert.equal(cwd, '/work');
  assert.equal(timeoutMs, 1000);
  assert.equal(valueOf('-p'), '스펙을 써라');
  assert.equal(valueOf('--max-turns'), '7');
  assert.equal(valueOf('--json-schema'), '{"type":"object"}');
  assert.equal(valueOf('--allowedTools'), 'Read,Glob,Grep');
  assert.ok(args.includes('--no-session-persistence'));
});

test('claude: 쓰기 과제는 편집 도구를 허용하고 모델 지정을 넘긴다', async () => {
  const { exec, calls } = fakeExec(done(fixture('claude-question.json')));
  await claudeAgent(exec)({ ...task, access: 'workspace-write', model: 'claude-sonnet-5-5' });
  const { args } = calls[0];
  assert.match(args[args.indexOf('--allowedTools') + 1], /Edit/);
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5-5');
});

test('codex: 마지막 메시지를 결과로 돌려주고 토큰 사용량을 정규화한다', async () => {
  const { exec } = fakeExec(done(fixture('codex-question.jsonl')));
  const r = await codexAgent(exec)(task);
  assert.ok(r.ok);
  assert.equal((r.output as { status: string }).status, 'question');
  assert.equal(r.agent, 'codex');
  assert.equal(r.usage.costUsd, null);
  assert.equal(r.usage.inputTokens, 57840);
  assert.equal(r.usage.outputTokens, 96);
  assert.equal(r.usage.turns, 1);
});

test('codex: 스키마를 파일로 넘기고 세션을 남기지 않으며 접근 범위를 샌드박스로 건다', async () => {
  const { exec, calls } = fakeExec(done(fixture('codex-question.jsonl')));
  await codexAgent(exec)(task);
  const [{ command, args, cwd }] = calls;
  assert.equal(command, 'codex');
  assert.equal(cwd, '/work');
  assert.equal(args[0], 'exec');
  assert.equal(args[args.indexOf('-s') + 1], 'read-only');
  assert.ok(args.includes('--ephemeral'));
  assert.ok(args.includes('--json'));
  assert.match(args[args.indexOf('--output-schema') + 1], /\.json$/);
  assert.equal(args.at(-1), '스펙을 써라');
});

test('codex: 마지막 메시지가 JSON이 아니면 invalid-output', async () => {
  const lines = '{"type":"item.completed","item":{"type":"agent_message","text":"죄송합니다"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}';
  const r = await codexAgent(fakeExec(done(lines)).exec)(task);
  assert.ok(!r.ok);
  assert.equal(r.reason, 'invalid-output');
});

for (const [name, make] of [['claude', claudeAgent], ['codex', codexAgent]] as const) {
  test(`${name}: 시간 한도를 넘기면 timeout 실패다`, async () => {
    const r = await make(fakeExec(done('', { code: null, timedOut: true })).exec)(task);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'timeout');
  });

  test(`${name}: 알 수 없는 출력으로 끝나면 failed이고 오류 내용을 남긴다`, async () => {
    const r = await make(fakeExec(done('', { code: 2, stderr: 'not logged in' })).exec)(task);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'failed');
    assert.match(r.detail, /not logged in/);
  });
}
