/**
 * 노드와 AI 사이의 유일한 계약.
 * Agent는 과제를 받아 결과를 돌려주는 함수다. 안에서 한 번 호출하든, 도구를 쓰며 여러 턴을 돌든,
 * 여러 에이전트를 묶든 노드는 알지 못한다. 여러 Agent를 묶은 함수도 Agent다.
 */

export type AgentTask = Readonly<{
  prompt: string;
  /** 결과가 따라야 할 JSON Schema. 모든 속성이 required이고 additionalProperties가 false여야 한다(codex 요구). */
  schema: object;
  cwd: string;
  access: 'read-only' | 'workspace-write';
  timeoutMs: number;
  maxTurns: number;
  model?: string;
}>;

export type Usage = Readonly<{
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  turns: number | null;
  durationMs: number;
}>;

export type AgentFailure = 'timeout' | 'turn-limit' | 'invalid-output' | 'failed';

export type AgentResult = Readonly<{ agent: string; model: string | null; usage: Usage }> &
  ({ ok: true; output: unknown } | { ok: false; reason: AgentFailure; detail: string });

export type Agent = (task: AgentTask) => Promise<AgentResult>;

export type ExecResult = Readonly<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;
export type Exec = (
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; timeoutMs: number }>,
) => Promise<ExecResult>;
