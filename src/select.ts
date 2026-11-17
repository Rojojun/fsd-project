import { PRIORITIES, SPEC_DONE } from './model.ts';
import type { RequirementDoc, RequirementState } from './model.ts';

export type Config = Readonly<{ wip: Readonly<{ spec: number; design: number }> }>;
export type Pick = { id: string; reason?: undefined } | { id: null; reason: string };
export type PickNode = 'spec' | 'design' | 'dev' | 'verify';

/** 노드별 후보 그룹. 앞 그룹이 먼저다. */
const GROUPS: Record<PickNode, readonly ((s: RequirementState) => boolean)[]> = {
  spec: [s => s.status === 'cataloged' || s.status === 'stale'],
  design: [s => s.status === 'specified' && s.designRequired],
  dev: [
    s => s.status === 'in-dev' && s.bug !== null,
    s => s.status === 'in-dev',
    s => s.status === 'designed' || (s.status === 'specified' && !s.designRequired),
  ],
  verify: [s => s.status === 'implemented'],
};

export const pickNext = (
  node: PickNode,
  docs: readonly RequirementDoc[],
  states: readonly RequirementState[],
  config: Config,
): Pick => {
  // 사람의 승인을 기다리는 초안이 한도만큼 쌓이면 새 초안을 만들지 않는다.
  if (node === 'spec' || node === 'design') {
    const waiting = states.filter(s => s.holds.some(h => h.kind === 'approval' && h.raisedBy === node)).length;
    if (waiting >= config.wip[node]) return { id: null, reason: `WIP 한도: ${node} 승인 대기 ${waiting}/${config.wip[node]}` };
  }

  const docById = new Map(docs.map(d => [d.id, d]));
  const statusById = new Map(states.map(s => [s.id, s.status]));
  const depsReady = (doc: RequirementDoc) => doc.depends.every(dep => SPEC_DONE.includes(statusById.get(dep)!));
  const rank = (s: RequirementState) => PRIORITIES.indexOf(docById.get(s.id)!.priority);

  const eligible = states.filter(s => {
    const doc = docById.get(s.id);
    return doc && s.holds.length === 0 && (node !== 'spec' || depsReady(doc));
  });
  const byPriority = (a: RequirementState, b: RequirementState) => rank(a) - rank(b) || a.id.localeCompare(b.id);
  const first = GROUPS[node]
    .map(inGroup => eligible.filter(inGroup).sort(byPriority))
    .find(group => group.length > 0)?.[0];

  return first ? { id: first.id } : { id: null, reason: `${node}: 처리할 후보가 없습니다.` };
};
