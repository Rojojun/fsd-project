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
  /** read-only: 읽기만. write-files: 파일 편집까지(셸 없음). workspace-write: 셸 실행까지. */
  access: 'read-only' | 'write-files' | 'workspace-write';
  /** 이 과제에 필요한 MCP 서버 이름. 있으면 실행하는 사람의 MCP 설정을 쓴다. */
  mcp?: readonly string[];
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
