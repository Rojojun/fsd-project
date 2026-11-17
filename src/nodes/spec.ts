import { pickNext } from '../select.ts';
import { checkSpecOutput, readSpec, renderSpec, specHash, SPEC_OUTPUT_SCHEMA, writeSpec } from '../spec.ts';
import { apply } from '../transitions.ts';
import type { Agent, AgentResult } from '../agents/types.ts';
import type { RequirementDoc, RequirementState } from '../model.ts';
import type { Config } from '../select.ts';

export type AgentSettings = Readonly<{ timeoutMs: number; maxTurns: number; model?: string }>;

export type SpecTickInput = Readonly<{
  root: string;
  docs: readonly RequirementDoc[];
  states: readonly RequirementState[];
  config: Config;
  agent: Agent;
  settings: AgentSettings;
  /** 스펙 작성 규칙 문서(skills/spec-writer.md)의 내용 */
  skill: string;
  /** 정책 ID → 정책 원문 */
  policies: Readonly<Record<string, string>>;
  at: string;
}>;

export type TickResult = Readonly<{
  id: string | null;
  outcome: 'idle' | 'question' | 'drafted' | 'invalid-output' | 'agent-failed';
  message: string;
  /** 바뀐 상태. 없으면 아무것도 바뀌지 않았다. */
  state?: RequirementState;
  run?: AgentResult;
}>;

const section = (title: string, body: string) => (body.trim() ? `# ${title}\n\n${body.trim()}` : '');

const buildPrompt = (input: SpecTickInput, doc: RequirementDoc, state: RequirementState): string => {
  const { root, docs, skill, policies } = input;
  const previous = state.status === 'stale' ? readSpec(root, doc.id) : null;
  const dependencies = doc.depends.flatMap(id => {
    const dep = readSpec(root, id);
    return dep ? [`## ${id} ${docs.find(d => d.id === id)?.title ?? ''}\n\n${renderSpec(dep)}`] : [];
  });
  return [
    skill.trim(),
    section('요구사항', `ID: ${doc.id}\n제목: ${doc.title}\n우선순위: ${doc.priority}\n\n${doc.body}`),
    section('근거 정책', doc.policies.map(id => `## ${id}\n\n${policies[id]}`).join('\n\n')),
    section('사람이 이미 내린 결정', state.decisions.map(d => `- 질문: ${d.question}\n  답: ${d.answer}`).join('\n')),
    section('이전 초안이 반려된 사유', state.feedback.map(f => `- ${f.message}`).join('\n')),
    section('선행 요구사항의 확정 스펙', dependencies.join('\n\n')),
    section('이전 스펙 (요구사항이 바뀌어 다시 확정해야 한다)', previous ? renderSpec(previous) : ''),
  ].filter(Boolean).join('\n\n---\n\n');
};

const joinQuestions = (questions: readonly string[]) =>
  questions.length === 1 ? questions[0] : questions.map((q, i) => `${i + 1}) ${q}`).join('\n');

/** spec 노드의 한 사이클: 후보 하나를 골라 스펙 초안을 받거나 질문을 남긴다. */
export const tickSpec = async (input: SpecTickInput): Promise<TickResult> => {
  const { root, docs, states, config, agent, settings, at } = input;
  const pick = pickNext('spec', docs, states, config);
  if (pick.id === null) return { id: null, outcome: 'idle', message: pick.reason };

  const doc = docs.find(d => d.id === pick.id)!;
  const state = states.find(s => s.id === pick.id)!;
  const run = await agent({
    prompt: buildPrompt(input, doc, state),
    schema: SPEC_OUTPUT_SCHEMA,
    cwd: root,
    access: 'read-only',
    ...settings,
  });
  const result = { id: doc.id, run };

  if (!run.ok) return { ...result, outcome: 'agent-failed', message: `에이전트 실패(${run.reason}): ${run.detail}` };

  const checked = checkSpecOutput(run.output, doc);
  if (!checked.ok) {
    return { ...result, outcome: 'invalid-output', message: `스펙 초안이 검사를 통과하지 못했습니다.\n${checked.errors.join('\n')}` };
  }
  if (checked.kind === 'question') {
    const question = joinQuestions(checked.questions);
    return { ...result, outcome: 'question', message: question, state: apply(state, 'ask', 'spec', { question }, at) };
  }
  // 초안을 저장소에 쓰고, 그 내용의 해시에 승인을 묶는다.
  writeSpec(root, doc, checked.spec);
  const drafted = apply(state, 'draftSpec', 'spec', { specHash: specHash(root, doc.id)! }, at);
  return { ...result, outcome: 'drafted', message: `스펙 초안 제출: ${checked.spec.summary}`, state: drafted };
};
