import { apply, register } from './transitions.ts';
import type { RequirementDoc, RequirementState } from './model.ts';

export type SyncChange = Readonly<{
  id: string;
  /** relink: 선행 관계만 바뀜(상태 유지). backfill: 예전 상태에 내용 지문만 채움(이력 없음). */
  transition: 'register' | 'reset' | 'invalidate' | 'deprecate' | 'revive' | 'relink' | 'backfill';
}>;

const decide = (doc: RequirementDoc | undefined, state: RequirementState | undefined): SyncChange['transition'] | null => {
  const gone = !doc || doc.deprecated;
  if (!state) return gone ? null : 'register';
  if (state.status === 'deprecated') return gone ? null : 'revive';
  if (gone) return 'deprecate';
  if (doc.hash === state.reqHash) return doc.contentHash && doc.contentHash !== state.contentHash ? 'backfill' : null;
  // 내용 지문이 같으면 바뀐 것은 선행 관계뿐이다. 작업 순서만 달라지니 확정된 산출물은 그대로 둔다.
  if (doc.contentHash && state.contentHash === doc.contentHash) return 'relink';
  return state.status === 'cataloged' || state.status === 'stale' ? 'reset' : 'invalidate';
};

const run = (change: SyncChange, doc: RequirementDoc | undefined, state: RequirementState | undefined, at: string) => {
  switch (change.transition) {
    case 'register': return register(change.id, doc!.hash, at);
    case 'deprecate': return apply(state!, 'deprecate', 'sync', {}, at);
    case 'backfill': return state!;
    default: return apply(state!, change.transition, 'sync', { reqHash: doc!.hash }, at);
  }
};

const withContent = (state: RequirementState, doc: RequirementDoc | undefined): RequirementState =>
  doc?.contentHash && !doc.deprecated ? { ...state, contentHash: doc.contentHash } : state;

/** 요구사항 파일과 저장된 상태를 비교해 바뀐 요구사항만 전이한다. 사람이 쓴 파일이 항상 이긴다. */
export const sync = (docs: readonly RequirementDoc[], states: readonly RequirementState[], at: string) => {
  const docById = new Map(docs.map(d => [d.id, d]));
  const stateById = new Map(states.map(s => [s.id, s]));
  const ids = [...new Set([...stateById.keys(), ...docById.keys()])].sort();
  const changes = ids.flatMap(id => {
    const transition = decide(docById.get(id), stateById.get(id));
    return transition ? [{ id, transition }] : [];
  });
  const next = new Map(stateById);
  changes.forEach(c => {
    const doc = docById.get(c.id);
    next.set(c.id, withContent(run(c, doc, stateById.get(c.id), at), doc));
  });
  return { changes, states: ids.map(id => next.get(id)!).filter(Boolean) };
};
