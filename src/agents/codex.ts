import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execProcess } from './exec.ts';
import type { Agent, AgentResult, AgentTask, Exec, ExecResult, Usage } from './types.ts';

const args = (task: AgentTask, schemaFile: string): string[] => [
  'exec',
  '--skip-git-repo-check',
  // 매번 새 세션. 맥락은 저장소에서만 온다.
  '--ephemeral',
  '-s', task.access,
  '--output-schema', schemaFile,
  '--json',
  ...(task.model ? ['-m', task.model] : []),
  task.prompt,
];

type Event = {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
};

const parseLine = (line: string): Event[] => {
  try {
    return [JSON.parse(line) as Event];
  } catch {
    return [];
  }
};

const parse = (run: ExecResult, task: AgentTask, durationMs: number): AgentResult => {
  const events = run.stdout.split('\n').flatMap(parseLine);
  const turns = events.filter(e => e.type === 'turn.completed');
  const sum = (key: 'input_tokens' | 'output_tokens') =>
    turns.length ? turns.reduce((n, t) => n + (t.usage?.[key] ?? 0), 0) : null;
  // codex는 비용을 알려 주지 않는다. 토큰 수만 남기고 환산은 집계 단계에서 한다.
  const usage: Usage = {
    costUsd: null,
    inputTokens: sum('input_tokens'),
    outputTokens: sum('output_tokens'),
    turns: turns.length || null,
    durationMs,
  };
  const base = { agent: 'codex', model: task.model ?? null, usage };
  const fail = (reason: 'timeout' | 'invalid-output' | 'failed', detail: string): AgentResult =>
    ({ ...base, ok: false, reason, detail });

  if (run.timedOut) return fail('timeout', `${task.timeoutMs}ms 안에 끝나지 않았습니다.`);
  const last = events.findLast(e => e.type === 'item.completed' && e.item?.type === 'agent_message')?.item?.text;
  if (run.code !== 0 || last === undefined) {
    return fail('failed', (run.stderr || run.stdout).trim().slice(-2000) || `종료 코드 ${run.code}`);
  }
  try {
    return { ...base, ok: true, output: JSON.parse(last) as unknown };
  } catch {
    return fail('invalid-output', `마지막 메시지가 JSON이 아닙니다: ${last.slice(0, 200)}`);
  }
};

export const codexAgent = (exec: Exec = execProcess): Agent => async task => {
  const dir = mkdtempSync(join(tmpdir(), 'agdd-codex-'));
  const schemaFile = join(dir, 'schema.json');
  writeFileSync(schemaFile, JSON.stringify(task.schema));
  const started = Date.now();
  try {
    const run = await exec('codex', args(task, schemaFile), { cwd: task.cwd, timeoutMs: task.timeoutMs });
    return parse(run, task, Date.now() - started);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
