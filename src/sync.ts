import { apply, register } from './transitions.ts';
import type { RequirementDoc, RequirementState } from './model.ts';

export type SyncChange = Readonly<{
  id: string;
  transition: 'register' | 'reset' | 'invalidate' | 'deprecate' | 'revive';
}>;

const decide = (doc: RequirementDoc | undefined, state: RequirementState | undefined): SyncChange['transition'] | null => {
  const gone = !doc || doc.deprecated;
  if (!state) return gone ? null : 'register';
  if (state.status === 'deprecated') return gone ? null : 'revive';
  if (gone) return 'deprecate';
  if (doc.hash === state.reqHash) return null;
  return state.status === 'cataloged' || state.status === 'stale' ? 'reset' : 'invalidate';
};

const run = (change: SyncChange, doc: RequirementDoc | undefined, state: RequirementState | undefined, at: string) => {
  switch (change.transition) {
    case 'register': return register(change.id, doc!.hash, at);
    case 'deprecate': return apply(state!, 'deprecate', 'sync', {}, at);
    default: return apply(state!, change.transition, 'sync', { reqHash: doc!.hash }, at);
  }
};

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
  changes.forEach(c => next.set(c.id, run(c, docById.get(c.id), stateById.get(c.id), at)));

  return { changes, states: ids.map(id => next.get(id)!).filter(Boolean) };
};
