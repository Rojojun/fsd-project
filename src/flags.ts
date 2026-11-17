import { ASPECTS, SPEC_DONE } from './model.ts';
import { apply } from './transitions.ts';
import type { Actor, Aspect, HistoryEntry, RequirementDoc, RequirementState } from './model.ts';

/**
 * 플래그는 저장하지 않는다. 상태와 이력에서 매번 계산한다.
 * 저장된 값이 없으니 실제 상태와 어긋날 수 없고, 새 경우가 생겨도 상태 파일 형식은 바뀌지 않는다.
 */

/** 상태 안의 세부 단계. 모든 상태가 같은 낱말을 나눠 쓴다. */
export type Phase =
  | 'waiting-answer'
  | 'waiting-approval'
  | 'blocked-by-dependency'
  | 'redraft'
  | 'ready'
  | 'building'
  | 'rework'
  | 'done'
  | 'closed';

export type Flags = Readonly<{
  phase: Phase;
  /** 스펙이 확정되지 않아 이 요구사항을 막고 있는 선행 요구사항 */
  blockedBy: readonly string[];
  staleReason: 'requirement-changed' | 'respec' | 'design-returned' | null;
  /** 디자인 검토의 관점별 상태. 디자인이 필요 없으면 null */
  review: Readonly<Record<Aspect, ReviewState>> | null;
  /** 현재 요구사항 내용에서 스펙 초안이 반려된 횟수 */
  rejections: number;
  /** 현재 승인 스펙에서 E2E 실패로 되돌아온 횟수 */
  reworks: number;
  /** 같은 증거로 연속 실패한 횟수 */
  sameFailureStreak: number;
  /** 가장 오래된 대기가 시작된 시각 */
  waitingSince: string | null;
}>;

/** none: 검토할 초안이 없음. pending: 검토 대기. approved: 승인. rejected: 이 관점에서 반려되어 다시 그려야 함. */
export type ReviewState = 'none' | 'pending' | 'approved' | 'rejected';

export type Limits = Readonly<{ rejections: number; reworks: number; sameFailure: number }>;

/** 마지막 경계 이후의 이력만 본다. 경계 = 세던 것을 다시 0부터 세게 만드는 전이. */
const since = (history: readonly HistoryEntry[], boundaries: readonly string[]) =>
  history.slice(history.findLastIndex(h => boundaries.includes(h.transition)) + 1);

const trailingRun = (notes: readonly (string | undefined)[]) => {
  const start = notes.findLastIndex(n => n !== notes.at(-1));
  return notes.length - 1 - start;
};

// 사람의 답(answer)은 어느 쪽이든 경계다. 사람이 개입했으면 반복 횟수를 다시 센다.
// 스펙 승인도 경계다. 그 뒤의 반려는 디자인 초안에 대한 것이므로 따로 센다.
const SPEC_ROUND = ['register', 'reset', 'invalidate', 'revive', 'respec', 'answer', 'approveSpec'];
const DEV_ROUND = ['approveSpec', 'answer'];

const counters = (state: RequirementState) => {
  const failures = since(state.history, DEV_ROUND).filter(h => h.transition === 'failVerify');
  return {
    rejections: since(state.history, SPEC_ROUND).filter(h => h.transition === 'reject').length,
    reworks: failures.length,
    sameFailureStreak: trailingRun(failures.map(f => f.note)),
  };
};

const phaseOf = (state: RequirementState, blocked: boolean, rejections: number): Phase => {
  if (state.status === 'deprecated') return 'closed';
  if (state.holds.some(h => h.kind === 'question')) return 'waiting-answer';
  if (state.holds.some(h => h.kind === 'approval')) return 'waiting-approval';
  switch (state.status) {
    case 'cataloged':
    case 'stale':
      return blocked ? 'blocked-by-dependency' : rejections > 0 ? 'redraft' : 'ready';
    case 'specified':
      return rejections > 0 ? 'redraft' : 'ready';
    case 'in-dev':
      return state.bug ? 'rework' : 'building';
    case 'verified':
      return 'done';
    default:
      return 'ready';
  }
};

const DESIGN_STAGE = ['specified', 'designed', 'in-dev', 'implemented', 'verified'];

const reviewOf = (state: RequirementState): Flags['review'] => {
  if (!state.designRequired || !DESIGN_STAGE.includes(state.status)) return null;
  const each = (of: (aspect: Aspect) => ReviewState) => Object.fromEntries(ASPECTS.map(a => [a, of(a)])) as Record<Aspect, ReviewState>;
  if (state.approvedDesignHash !== null) return each(() => 'approved');

  const waiting = state.holds.filter(h => h.kind === 'approval' && h.raisedBy === 'design');
  if (waiting.length) return each(a => (waiting.some(h => h.aspect === a) ? 'pending' : 'approved'));

  // 대기가 없다: 아직 초안이 없거나, 마지막 초안이 반려됐다.
  const last = since(state.history, ['approveSpec']).findLast(h => h.transition === 'draftDesign' || h.transition === 'reject');
  if (last?.transition !== 'reject') return each(() => 'none');
  return each(a => (last.note === 'all' || last.note === a ? 'rejected' : 'none'));
};

export const flagsOf = (
  state: RequirementState,
  doc: RequirementDoc | undefined,
  states: readonly RequirementState[],
): Flags => {
  const statusById = new Map(states.map(s => [s.id, s.status]));
  const preSpec = state.status === 'cataloged' || state.status === 'stale';
  const blockedBy = preSpec ? (doc?.depends ?? []).filter(dep => !SPEC_DONE.includes(statusById.get(dep)!)) : [];
  const count = counters(state);
  const staleCause = state.status === 'stale'
    ? state.history.findLast(h => ['invalidate', 'respec', 'returnToSpec'].includes(h.transition))?.transition
    : undefined;

  return {
    phase: phaseOf(state, blockedBy.length > 0, count.rejections),
    blockedBy,
    staleReason: staleCause === 'invalidate' ? 'requirement-changed'
      : staleCause === 'respec' ? 'respec'
      : staleCause === 'returnToSpec' ? 'design-returned'
      : null,
    review: reviewOf(state),
    ...count,
    waitingSince: state.holds.map(h => h.at).sort()[0] ?? null,
  };
};

/** 같은 일을 되풀이하는 요구사항을 찾아, 누가 무엇을 물어야 하는지 돌려준다. */
const stuck = (state: RequirementState, limits: Limits): { actor: Actor; question: string } | null => {
  if (state.holds.length > 0) return null;
  const { rejections, reworks, sameFailureStreak } = counters(state);
  if ((state.status === 'cataloged' || state.status === 'stale') && rejections >= limits.rejections) {
    return { actor: 'spec', question: `스펙 초안이 ${rejections}회 반려되었습니다. 요구사항을 고칠지, 어떤 방향으로 다시 쓸지 알려 주세요.` };
  }
  if (state.status === 'specified' && rejections >= limits.rejections) {
    return { actor: 'design', question: `디자인 초안이 ${rejections}회 반려되었습니다. 어떤 방향으로 다시 그릴지, 스펙을 다시 열지 알려 주세요.` };
  }
  if (state.status !== 'in-dev') return null;
  if (sameFailureStreak >= limits.sameFailure) {
    return { actor: 'dev', question: `같은 E2E 실패가 ${sameFailureStreak}회 반복되었습니다. 스펙을 다시 열지, 계속 시도할지 알려 주세요.` };
  }
  if (reworks >= limits.reworks) {
    return { actor: 'dev', question: `E2E 실패로 ${reworks}회 재작업했습니다. 스펙을 다시 열지, 계속 시도할지 알려 주세요.` };
  }
  return null;
};

/** 반복이 한도에 닿은 요구사항에 질문 대기를 붙여 사람에게 넘긴다. 노드는 더 시도하지 않는다. */
export const escalate = (states: readonly RequirementState[], limits: Limits, at: string) => {
  const next = states.map(state => {
    const reason = stuck(state, limits);
    return reason ? apply(state, 'ask', reason.actor, { question: reason.question }, at) : state;
  });
  return { states: next, changes: next.filter((s, i) => s !== states[i]).map(s => ({ id: s.id })) };
};
