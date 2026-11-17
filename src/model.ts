export const STATUSES = ['cataloged', 'specified', 'designed', 'in-dev', 'implemented', 'verified', 'stale', 'deprecated'] as const;
export type Status = (typeof STATUSES)[number];

/** 승인된 스펙이 있는 상태 */
export const SPEC_DONE: readonly Status[] = ['specified', 'designed', 'in-dev', 'implemented', 'verified'];

export const NODES = ['spec', 'design', 'dev', 'verify', 'audit'] as const;
export type Node = (typeof NODES)[number];
export type Actor = Node | 'sync' | 'human';

export type HoldKind = 'question' | 'approval';

/** 디자인 검토의 두 관점. ui: 보이는 것(디자인 언어 준수), ux: 쓰는 흐름(상태·피드백·접근성). */
export const ASPECTS = ['ui', 'ux'] as const;
export type Aspect = (typeof ASPECTS)[number];

export type Hold = Readonly<{
  id: string;
  kind: HoldKind;
  raisedBy: Actor;
  message: string;
  at: string;
  artifactHash: string | null;
  /** 디자인 승인 대기일 때, 어느 관점의 검토인지 */
  aspect?: Aspect;
}>;

export type Decision = Readonly<{ question: string; answer: string; reqHash: string; at: string }>;
export type Feedback = Readonly<{
  message: string;
  /** 지적받은 산출물(스펙 또는 디자인)의 해시 */
  specHash: string | null;
  at: string;
  /** 무엇에 대한 지적인지. 다음에 그 산출물을 다시 만드는 노드가 읽는다. */
  about: 'spec' | 'design';
  aspect?: Aspect;
}>;
export type Bug = Readonly<{ evidence: string; at: string }>;

export type HistoryEntry = Readonly<{
  from: Status | null;
  to: Status;
  transition: string;
  actor: Actor;
  at: string;
  message: string;
  note?: string;
}>;

export type RequirementState = Readonly<{
  id: string;
  status: Status;
  reqHash: string;
  holds: readonly Hold[];
  approvedSpecHash: string | null;
  /** 스펙 승인 때 함께 확정된 값. true면 디자인 승인 전에는 구현할 수 없다. */
  designRequired: boolean;
  approvedDesignHash: string | null;
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
  /** 디자인 필요 여부를 사람이 못박은 값. null이면 spec 노드의 판단을 따른다. */
  design: boolean | null;
  deprecated: boolean;
  body: string;
  hash: string;
}>;
