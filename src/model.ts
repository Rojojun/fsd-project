export const STATUSES = ['cataloged', 'specified', 'in-dev', 'implemented', 'verified', 'stale', 'deprecated'] as const;
export type Status = (typeof STATUSES)[number];

export const NODES = ['spec', 'dev', 'verify', 'audit'] as const;
export type Node = (typeof NODES)[number];
export type Actor = Node | 'sync' | 'human';

export type HoldKind = 'question' | 'approval';

export type Hold = Readonly<{
  id: string;
  kind: HoldKind;
  raisedBy: Actor;
  message: string;
  at: string;
  artifactHash: string | null;
}>;

export type Decision = Readonly<{ question: string; answer: string; reqHash: string; at: string }>;
export type Feedback = Readonly<{ message: string; specHash: string | null; at: string }>;
export type Bug = Readonly<{ evidence: string; at: string }>;

export type HistoryEntry = Readonly<{
  from: Status | null;
  to: Status;
  transition: string;
  actor: Actor;
  at: string;
  message: string;
}>;

export type RequirementState = Readonly<{
  id: string;
  status: Status;
  reqHash: string;
  holds: readonly Hold[];
  approvedSpecHash: string | null;
  bug: Bug | null;
  decisions: readonly Decision[];
  feedback: readonly Feedback[];
  history: readonly HistoryEntry[];
}>;

export const PRIORITIES = ['P0', 'P1', 'P2'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** 사람이 쓰는 요구사항 파일(requirements/<id>.md)을 읽은 결과 */
export type RequirementDoc = Readonly<{
  id: string;
  title: string;
  priority: Priority;
  depends: readonly string[];
  policies: readonly string[];
  deprecated: boolean;
  body: string;
  hash: string;
}>;
