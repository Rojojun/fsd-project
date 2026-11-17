import { NODES, SPEC_DONE } from './model.ts';
import type { Actor, Hold, HoldKind, RequirementState, Status } from './model.ts';

/** docs/graph.md의 "전이 규칙" 표를 그대로 옮긴 것 */

export class TransitionError extends Error {}

type Inputs = {
  reset: { reqHash: string };
  invalidate: { reqHash: string };
  deprecate: Record<string, never>;
  revive: { reqHash: string };
  draftSpec: { specHash: string; message?: string };
  ask: { question: string };
  answer: { answer: string; holdId?: string };
  approveSpec: { specHash: string };
  reject: { reason: string };
  startDev: Record<string, never>;
  finishDev: { specHash: string };
  passVerify: Record<string, never>;
  failVerify: { evidence: string };
  respec: { reason: string };
};
export type TransitionName = keyof Inputs;

type Ctx<I> = Readonly<{ state: RequirementState; input: I; actor: Actor; at: string }>;

type Rule<I> = Readonly<{
  from: readonly Status[];
  to: Status | 'keep';
  actors: readonly Actor[];
  guard?: (ctx: Ctx<I>) => string | null;
  effect?: (ctx: Ctx<I>) => Partial<RequirementState>;
  message?: (ctx: Ctx<I>) => string;
  /** 이력에 남길 근거. 플래그 계산(src/flags.ts)이 읽는다. */
  note?: (ctx: Ctx<I>) => string;
}>;

const ALIVE: readonly Status[] = ['cataloged', 'specified', 'in-dev', 'implemented', 'verified', 'stale'];
const PRE_SPEC: readonly Status[] = ['cataloged', 'stale'];
const POST_SPEC = SPEC_DONE;

const holdsOf = (s: RequirementState, kind: HoldKind) => s.holds.filter(h => h.kind === kind);
const without = (s: RequirementState, kind: HoldKind) => s.holds.filter(h => h.kind !== kind);

const newHold = (ctx: Ctx<unknown>, kind: HoldKind, message: string, artifactHash: string | null): Hold => ({
  id: `${kind === 'question' ? 'Q' : 'A'}${ctx.state.history.length}`,
  kind,
  raisedBy: ctx.actor,
  message,
  at: ctx.at,
  artifactHash,
});

const findQuestion = (s: RequirementState, holdId?: string): Hold | string => {
  const questions = holdsOf(s, 'question');
  if (holdId) return questions.find(q => q.id === holdId) ?? `열린 질문 ${holdId}가 없습니다.`;
  if (questions.length === 1) return questions[0];
  return questions.length === 0 ? '열린 질문이 없습니다.' : '열린 질문이 여럿이라 holdId가 필요합니다.';
};

const RULES: { [N in TransitionName]: Rule<Inputs[N]> } = {
  reset: {
    from: PRE_SPEC, to: 'keep', actors: ['sync'],
    effect: ({ input }) => ({ reqHash: input.reqHash, holds: [] }),
    message: () => '요구사항 변경 → 초안과 대기를 폐기',
  },
  invalidate: {
    from: POST_SPEC, to: 'stale', actors: ['sync'],
    effect: ({ input }) => ({ reqHash: input.reqHash, holds: [], bug: null }),
    message: () => '확정 이후 요구사항 변경 → 재확정 필요',
  },
  deprecate: {
    from: ALIVE, to: 'deprecated', actors: ['sync'],
    effect: () => ({ holds: [] }),
    message: () => '요구사항 폐기',
  },
  revive: {
    from: ['deprecated'], to: 'cataloged', actors: ['sync'],
    effect: ({ input }) => ({ reqHash: input.reqHash }),
    message: () => '요구사항 복원',
  },
  draftSpec: {
    from: PRE_SPEC, to: 'keep', actors: ['spec'],
    effect: ctx => ({
      holds: [...ctx.state.holds, newHold(ctx, 'approval', ctx.input.message ?? '스펙 초안 승인 요청', ctx.input.specHash)],
    }),
    message: () => '스펙 초안 제출 → 승인 대기',
  },
  ask: {
    from: ALIVE, to: 'keep', actors: NODES,
    effect: ctx => ({ holds: [...ctx.state.holds, newHold(ctx, 'question', ctx.input.question, null)] }),
    message: ({ input }) => `질문: ${input.question}`,
  },
  answer: {
    from: ALIVE, to: 'keep', actors: ['human'],
    guard: ({ state, input }) => {
      const q = findQuestion(state, input.holdId);
      return typeof q === 'string' ? q : null;
    },
    effect: ({ state, input, at }) => {
      const q = findQuestion(state, input.holdId) as Hold;
      return {
        holds: state.holds.filter(h => h.id !== q.id),
        decisions: [...state.decisions, { question: q.message, answer: input.answer, reqHash: state.reqHash, at }],
      };
    },
    message: ({ input }) => `답변: ${input.answer}`,
  },
  approveSpec: {
    from: PRE_SPEC, to: 'specified', actors: ['human'],
    guard: ({ state, input }) => {
      const [approval] = holdsOf(state, 'approval');
      if (!approval) return '승인 대기 중인 스펙 초안이 없습니다.';
      return approval.artifactHash === input.specHash ? null : '승인하려는 스펙 해시가 제출된 초안과 다릅니다.';
    },
    effect: ({ state, input }) => ({ holds: without(state, 'approval'), approvedSpecHash: input.specHash }),
    message: () => '스펙 승인',
  },
  reject: {
    from: ALIVE, to: 'keep', actors: ['human'],
    guard: ({ state }) => (holdsOf(state, 'approval').length ? null : '승인 대기가 없습니다.'),
    effect: ({ state, input, at }) => ({
      holds: without(state, 'approval'),
      feedback: [...state.feedback, { message: input.reason, specHash: holdsOf(state, 'approval')[0].artifactHash, at }],
    }),
    message: ({ input }) => `반려: ${input.reason}`,
  },
  startDev: { from: ['specified'], to: 'in-dev', actors: ['dev'], message: () => '구현 착수' },
  finishDev: {
    from: ['in-dev'], to: 'implemented', actors: ['dev'],
    guard: ({ state, input }) =>
      state.approvedSpecHash === input.specHash ? null : 'Spec Gate: 구현 기준 스펙이 승인된 스펙과 다릅니다.',
    message: () => '구현 완료',
  },
  passVerify: {
    from: ['implemented'], to: 'verified', actors: ['verify'],
    effect: () => ({ bug: null }),
    message: () => 'E2E 통과',
  },
  failVerify: {
    from: ['implemented'], to: 'in-dev', actors: ['verify'],
    effect: ({ input, at }) => ({ bug: { evidence: input.evidence, at } }),
    message: () => 'E2E 실패 → 버그 기록',
    note: ({ input }) => input.evidence,
  },
  respec: {
    from: POST_SPEC, to: 'stale', actors: ['human'],
    effect: () => ({ holds: [] }),
    message: ({ input }) => `스펙 재확정 결정: ${input.reason}`,
  },
};

const isNode = (actor: Actor) => (NODES as readonly Actor[]).includes(actor);

const violation = <I>(rule: Rule<I>, name: string, ctx: Ctx<I>): string | null => {
  const { state, actor } = ctx;
  if (!rule.from.includes(state.status)) return `${name}: ${state.status} 상태에서는 할 수 없습니다.`;
  if (!rule.actors.includes(actor)) return `${name}: ${actor}는 이 전이를 할 수 없습니다.`;
  if (isNode(actor) && state.holds.length > 0) return `${name}: 대기(hold) 중인 요구사항입니다.`;
  return rule.guard?.(ctx) ?? null;
};

export const apply = <N extends TransitionName>(
  state: RequirementState,
  name: N,
  actor: Actor,
  input: Inputs[N],
  at: string,
): RequirementState => {
  const rule = RULES[name] as Rule<Inputs[N]>;
  const ctx: Ctx<Inputs[N]> = { state, input, actor, at };
  const error = violation(rule, name, ctx);
  if (error) throw new TransitionError(error);
  const to = rule.to === 'keep' ? state.status : rule.to;
  return {
    ...state,
    ...rule.effect?.(ctx),
    status: to,
    history: [
      ...state.history,
      {
        from: state.status, to, transition: name, actor, at,
        message: rule.message?.(ctx) ?? name,
        ...(rule.note ? { note: rule.note(ctx) } : {}),
      },
    ],
  };
};

export const register = (id: string, reqHash: string, at: string): RequirementState => ({
  id,
  status: 'cataloged',
  reqHash,
  holds: [],
  approvedSpecHash: null,
  bug: null,
  decisions: [],
  feedback: [],
  history: [{ from: null, to: 'cataloged', transition: 'register', actor: 'sync', at, message: '요구사항 등록' }],
});
