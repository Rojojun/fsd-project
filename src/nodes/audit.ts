import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditKey, AUDIT_OUTPUT_SCHEMA, checkAuditOutput, formatFinding, isSuppressed, specText } from '../audit.ts';
import { fingerprint } from '../catalog.ts';
import { SPEC_DONE } from '../model.ts';
import { readSpec, specHash } from '../spec.ts';
import { apply } from '../transitions.ts';
import { section } from './spec.ts';
import type { Agent } from '../agents/types.ts';
import type { Finding } from '../audit.ts';
import type { RequirementDoc, RequirementState } from '../model.ts';
import type { SavedSpec } from '../spec.ts';
import type { AgentSettings, TickResult } from './spec.ts';

export type AuditTickInput = Readonly<{
  root: string;
  docs: readonly RequirementDoc[];
  states: readonly RequirementState[];
  agent: Agent;
  settings: AgentSettings;
  /** audit 규칙 문서(skills/audit.md)의 내용 */
  skill: string;
  /** 정책 ID → 정책 원문 */
  policies: Readonly<Record<string, string>>;
  /** 한 번에 올릴 지적의 최대 수 */
  maxFindings?: number;
  at: string;
}>;

const lastFile = (root: string) => join(root, '.fsd', 'audit', 'last.json');

const readLast = (root: string): { fingerprint?: string | null } =>
  existsSync(lastFile(root)) ? (JSON.parse(readFileSync(lastFile(root), 'utf8')) as { fingerprint?: string | null }) : {};

const writeLast = (root: string, record: object) => {
  mkdirSync(join(root, '.fsd', 'audit'), { recursive: true });
  writeFileSync(lastFile(root), JSON.stringify(record, null, 2) + '\n');
};

const buildPrompt = (input: AuditTickInput, audited: readonly { doc: RequirementDoc; spec: SavedSpec }[]) => {
  const { skill, policies, states } = input;
  const cited = [...new Set(audited.flatMap(a => a.doc.policies))];
  const decided = states.flatMap(s => s.decisions.filter(d => d.question.includes('[audit:')).map(d => `- ${d.question}\n  → 사람의 답: ${d.answer}`));
  const open = states.flatMap(s => s.holds.filter(h => h.raisedBy === 'audit').map(h => `- (${s.id}에 열려 있음) ${h.message.split('\n')[0]}`));
  return [
    skill.trim(),
    section('확정된 스펙', audited.map(a => specText(a.doc, a.spec)).join('\n\n---\n\n')),
    section('근거 정책', cited.map(id => `## ${id}\n\n${policies[id] ?? '(정책 파일 없음)'}`).join('\n\n')),
    section('이미 사람이 판단한 지적 (다시 올리지 않는다)', decided.join('\n')),
    section('이미 열려 있는 지적 (다시 올리지 않는다)', open.join('\n')),
  ].filter(Boolean).join('\n\n---\n\n');
};

const COMMANDS = (id: string) => `고치려면: fsd respec ${id} "<사유>"   문제가 아니면: fsd answer ${id} "<이유>"`;

/**
 * audit 노드의 한 사이클.
 * 확정된 스펙 전체를 한 번에 읽는다. 마지막 검토 뒤로 스펙이 바뀌지 않았으면 돌지 않는다.
 * 지적은 고칠 요구사항에 질문 대기로 붙인다. 사람이 respec(고친다) 또는 answer(문제 아님)로 판단한다.
 */
export const tickAudit = async (input: AuditTickInput): Promise<TickResult> => {
  const { root, docs, states, agent, settings, at, maxFindings = 5 } = input;
  const audited = states
    .filter(s => SPEC_DONE.includes(s.status))
    .flatMap(s => {
      const doc = docs.find(d => d.id === s.id);
      const spec = readSpec(root, s.id);
      return doc && spec ? [{ doc, spec }] : [];
    })
    .sort((a, b) => a.doc.id.localeCompare(b.doc.id));
  if (audited.length === 0) return { id: null, outcome: 'idle', message: 'audit: 확정된 스펙이 없습니다.' };

  const policyText = [...new Set(audited.flatMap(a => a.doc.policies))].sort().map(id => `${id}\0${input.policies[id] ?? ''}`).join('\0');
  const print = fingerprint(JSON.stringify([audited.map(a => [a.doc.id, a.doc.hash, specHash(root, a.doc.id)]), policyText]));
  if (readLast(root).fingerprint === print) {
    return { id: null, outcome: 'idle', message: 'audit: 마지막 검토 뒤로 바뀐 스펙이 없습니다.' };
  }

  const run = await agent({ prompt: buildPrompt(input, audited), schema: AUDIT_OUTPUT_SCHEMA, cwd: root, access: 'read-only', ...settings });
  if (!run.ok) return { id: null, run, outcome: 'agent-failed', message: `audit 에이전트 실패(${run.reason}): ${run.detail}` };

  const checked = checkAuditOutput(run.output, { specs: Object.fromEntries(audited.map(a => [a.doc.id, a.spec])), docs });
  if (!checked.ok) return { id: null, run, outcome: 'invalid-output', message: checked.message };

  const suppressed = checked.findings.filter(f => isSuppressed(auditKey(f), f.requirements, states));
  const fresh = checked.findings.filter(f => !suppressed.includes(f));
  const busy = fresh.filter(f => (states.find(s => s.id === f.fixIn)?.holds.length ?? 0) > 0);
  const ready = fresh.filter(f => !busy.includes(f));
  const raised = ready.slice(0, maxFindings);
  const deferred = ready.slice(maxFindings);

  // 같은 요구사항에 올릴 지적은 질문 하나로 묶는다.
  const byFix = Map.groupBy(raised, f => f.fixIn);
  const changed = [...byFix].map(([id, list]) => {
    const question = [...list.map(formatFinding), COMMANDS(id)].join('\n\n');
    return apply(states.find(s => s.id === id)!, 'ask', 'audit', { question }, at);
  });

  // 올리지 못하고 미룬 지적이 있으면 다음에 다시 돌도록 지문을 남기지 않는다.
  const complete = deferred.length === 0 && busy.length === 0;
  writeLast(root, {
    at, fingerprint: complete ? print : null,
    raised, deferred, busy, suppressed, rejected: checked.rejected,
  });

  const lines = (label: string, list: readonly Finding[]) => (list.length ? `${label} ${list.length}건` : '');
  const message = [
    raised.length ? `지적 ${raised.length}건을 올렸습니다: ${[...byFix.keys()].join(', ')}` : '지적할 것이 없습니다.',
    ...raised.map(f => `- [${f.fixIn}] ${f.summary}`),
    checked.rejected.length ? `버린 지적 ${checked.rejected.length}건 (인용을 대조하지 못함 등):\n${checked.rejected.map(r => `- ${r.reason}`).join('\n')}` : '',
    suppressed.length ? `${lines('이미 물었거나 사람이 판단한 지적', suppressed)}은 다시 올리지 않았습니다.` : '',
    busy.length ? `${busy.map(f => f.fixIn).join(', ')}은(는) 이미 대기 중이라 이번에 올리지 않았습니다(${busy.length}건). 대기가 풀린 뒤 다시 검토합니다.` : '',
    deferred.length ? `나머지 ${deferred.length}건은 다음 audit에서 올립니다.` : '',
  ].filter(Boolean).join('\n');

  return { id: null, run, outcome: raised.length ? 'findings' : 'clean', message, states: changed };
};
