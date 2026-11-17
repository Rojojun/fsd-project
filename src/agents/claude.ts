import { execProcess } from './exec.ts';
import type { Agent, AgentResult, AgentTask, Exec, ExecResult, Usage } from './types.ts';

const TOOLS = { 'read-only': 'Read,Glob,Grep', 'workspace-write': 'Read,Glob,Grep,Edit,Write,Bash' };

const args = (task: AgentTask): string[] => [
  '-p', task.prompt,
  '--output-format', 'json',
  '--json-schema', JSON.stringify(task.schema),
  '--max-turns', String(task.maxTurns),
  '--allowedTools', TOOLS[task.access],
  '--permission-mode', 'dontAsk',
  // 매번 새 세션. 맥락은 저장소에서만 온다.
  '--no-session-persistence',
  // 실행하는 사람의 개인 설정(플러그인, MCP)에 결과가 좌우되지 않게 한다.
  '--setting-sources', 'project',
  '--strict-mcp-config',
  ...(task.model ? ['--model', task.model] : []),
];

type Output = {
  subtype?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  structured_output?: unknown;
  usage?: Record<string, number>;
  modelUsage?: Record<string, unknown>;
  errors?: string[];
  result?: string;
};

const parseJson = (text: string): Output | null => {
  try {
    return JSON.parse(text) as Output;
  } catch {
    return null;
  }
};

const parse = (run: ExecResult, task: AgentTask, durationMs: number): AgentResult => {
  const data = parseJson(run.stdout);
  const u = data?.usage;
  const usage: Usage = {
    costUsd: data?.total_cost_usd ?? null,
    inputTokens: u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : null,
    outputTokens: u?.output_tokens ?? null,
    turns: data?.num_turns ?? null,
    durationMs,
  };
  const base = { agent: 'claude', model: Object.keys(data?.modelUsage ?? {})[0] ?? task.model ?? null, usage };
  const fail = (reason: 'timeout' | 'turn-limit' | 'invalid-output' | 'failed', detail: string): AgentResult =>
    ({ ...base, ok: false, reason, detail });

  if (run.timedOut) return fail('timeout', `${task.timeoutMs}ms 안에 끝나지 않았습니다.`);
  if (!data) return fail('failed', (run.stderr || run.stdout).trim().slice(-2000) || `종료 코드 ${run.code}`);
  if (data.subtype === 'error_max_turns') return fail('turn-limit', `턴 한도 ${task.maxTurns}에 닿았습니다.`);
  if (data.is_error) return fail('failed', data.errors?.join('\n') || data.result || data.subtype || '알 수 없는 오류');
  if (data.structured_output === undefined || data.structured_output === null) {
    return fail('invalid-output', '구조화 출력이 없습니다.');
  }
  return { ...base, ok: true, output: data.structured_output };
};

export const claudeAgent = (exec: Exec = execProcess): Agent => async task => {
  const started = Date.now();
  const run = await exec('claude', args(task), { cwd: task.cwd, timeoutMs: task.timeoutMs });
  return parse(run, task, Date.now() - started);
};
