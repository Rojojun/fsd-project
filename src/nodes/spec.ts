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
  /** 디자인 언어(design/ui.md, design/ux.md)가 정해져 있는가 */
  designLanguageReady: boolean;
  /** 정책 ID → 정책 원문 */
  policies: Readonly<Record<string, string>>;
  at: string;
}>;

export type TickResult = Readonly<{
  id: string | null;
  /** returned: 이전 단계로 되돌렸다 */
  outcome:
    | 'idle' | 'question' | 'drafted' | 'returned' | 'invalid-output' | 'agent-failed'
    /** implemented: 구현 완료. verified: E2E 통과. failed: E2E 실패(버그 기록) */
    | 'implemented' | 'verified' | 'failed'
    /** audit: 지적을 올렸다 / 지적할 것이 없다 */
    | 'findings' | 'clean';
  message: string;
  /** 바뀐 상태. 없으면 아무것도 바뀌지 않았다. */
  state?: RequirementState;
  run?: AgentResult;
  /** 요구사항 여럿의 상태를 바꾼 사이클(audit) */
  states?: readonly RequirementState[];
  /** 에이전트를 여럿 부른 사이클의 호출들 */
  runs?: readonly Readonly<{ part: string; run: AgentResult }>[];
}>;

export const section = (title: string, body: string) => (body.trim() ? `# ${title}\n\n${body.trim()}` : '');

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
    // policies는 정책 파일(policies/<ID>.md)만 뜻한다. 본문에 나오는 다른 정책 번호와 헷갈리지 않게 분명히 적는다.
    doc.policies.length
      ? section('근거 정책', `스펙의 policies에는 아래 ID만 쓴다: ${doc.policies.join(', ')}\n\n${doc.policies.map(id => `## ${id}\n\n${policies[id]}`).join('\n\n')}`)
      : section('근거 정책', '이 요구사항이 근거로 든 정책 파일은 없다. 스펙의 policies는 빈 배열로 둔다.\n요구사항 본문에 정책 번호(예: POL-001)가 나오면 그 내용은 계약과 인수 조건의 글 속에 반영한다.'),
    section('사람이 이미 내린 결정', state.decisions.map(d => `- 질문: ${d.question}\n  답: ${d.answer}`).join('\n')),
    section('이전 스펙에 대한 사람의 지적 (모두 반영한다)', state.feedback.filter(f => f.about !== 'design').map(f => `- ${f.message}`).join('\n')),
    section('디자인 언어', input.designLanguageReady ? '`design/ui.md`와 `design/ux.md`에 정해져 있다. 디자인 언어에 대해서는 묻지 않는다.' : ''),
    section('선행 요구사항의 확정 스펙', dependencies.join('\n\n')),
    section('이전 스펙 (요구사항이 바뀌어 다시 확정해야 한다)', previous ? renderSpec(previous) : ''),
  ].filter(Boolean).join('\n\n---\n\n');
};

/** 에이전트가 스스로 붙인 번호("1)", "2.", "(3)")는 떼고 다시 붙인다. */
const unnumbered = (question: string) => question.trim().replace(/^\(?\d+[).]\s*/, '');

export const joinQuestions = (questions: readonly string[]) => {
  const clean = questions.map(unnumbered);
  return clean.length === 1 ? clean[0] : clean.map((q, i) => `${i + 1}) ${q}`).join('\n');
};

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
  // 디자인이 필요한데 디자인 언어가 없으면 스펙을 확정해도 디자인 단계에서 되돌아온다. 여기서 먼저 묻는다.
  if ((doc.design ?? checked.spec.design.needed) && !input.designLanguageReady) {
    const question = '이 요구사항은 화면 디자인이 필요한데 디자인 언어가 정해져 있지 않습니다. '
      + '`design/ui.md`(UI 기준)와 `design/ux.md`(UX 기준)를 작성한 뒤 "작성했다"고 답해 주세요. '
      + '디자인이 필요 없다면 요구사항 머리말에 `design: false`를 적어 주세요.';
    return { ...result, outcome: 'question', message: question, state: apply(state, 'ask', 'spec', { question }, at) };
  }
  // 초안을 저장소에 쓰고, 그 내용의 해시에 승인을 묶는다.
  writeSpec(root, doc, checked.spec);
  const drafted = apply(state, 'draftSpec', 'spec', { specHash: specHash(root, doc.id)! }, at);
  return { ...result, outcome: 'drafted', message: `스펙 초안 제출: ${checked.spec.summary}`, state: drafted };
};
