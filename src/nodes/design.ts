import { checkDesignOutput, designHash, DESIGN_OUTPUT_SCHEMA, htmlPath, missingLanguage, readDesign, renderDesign, writeDesign } from '../design.ts';
import { pickNext } from '../select.ts';
import { readSpec, renderSpec, specHash } from '../spec.ts';
import { apply } from '../transitions.ts';
import { joinQuestions, section } from './spec.ts';
import type { Agent } from '../agents/types.ts';
import type { DesignLanguage, Surface } from '../design.ts';
import type { RequirementDoc, RequirementState } from '../model.ts';
import type { Config } from '../select.ts';
import type { AgentSettings, TickResult } from './spec.ts';

export type DesignTickInput = Readonly<{
  root: string;
  docs: readonly RequirementDoc[];
  states: readonly RequirementState[];
  config: Config;
  agent: Agent;
  /** 어디에 그릴지. 호출하는 쪽이 연결된 도구를 보고 정해서 넘긴다. */
  surface: Surface;
  /** 쓸 MCP 서버 이름. html이면 null */
  server: string | null;
  settings: AgentSettings;
  /** 디자인 규칙 문서(skills/designer.md)의 내용 */
  skill: string;
  /** 고른 도구에서 그리는 법(skills/design-<surface>.md)의 내용 */
  surfaceGuide: string;
  /** 디자인 언어 문서의 내용. 정해지지 않은 쪽은 null */
  language: DesignLanguage;
  at: string;
}>;

/** 디자인에 대한 지적만. 스펙에 대한 지적은 spec 노드의 몫이다. */
const designFeedback = (state: RequirementState) => state.feedback.filter(f => f.about === 'design');

const buildPrompt = (input: DesignTickInput, doc: RequirementDoc, state: RequirementState): string => {
  const { root, skill, surfaceGuide, surface, language } = input;
  const previous = readDesign(root, doc.id);
  const target = surface === 'html'
    ? `단일 HTML 파일 하나를 \`${htmlPath(doc.id)}\`에 쓴다. 다른 파일은 만들거나 고치지 않는다. location에는 이 경로를 적는다.`
    : `${surface}에 그린다. 저장소의 파일은 고치지 않는다. location에는 사람이 열어 볼 수 있는 ${surface} 주소를 적는다.`;
  return [
    skill.trim(),
    surfaceGuide.trim(),
    section('그릴 곳', target),
    section('요구사항', `ID: ${doc.id}\n제목: ${doc.title}\n\n${doc.body}`),
    section('확정된 스펙 (이 범위를 넘지 않는다)', renderSpec(readSpec(root, doc.id)!)),
    section('UI 기준 (design/ui.md)', language.ui ?? ''),
    section('UX 기준 (design/ux.md)', language.ux ?? ''),
    section('이전 디자인에 대한 사람의 지적 (모두 반영하고, 하나하나 명문화한다)', designFeedback(state).map(f => `- [${f.aspect ? f.aspect.toUpperCase() : 'UI·UX'}] ${f.message}`).join('\n')),
    section('이전 디자인', previous ? renderDesign(previous) : ''),
  ].filter(Boolean).join('\n\n---\n\n');
};

/** design 노드의 한 사이클: 디자인이 필요한 요구사항 하나를 골라 초안을 받거나 질문을 남긴다. */
export const tickDesign = async (input: DesignTickInput): Promise<TickResult> => {
  const { root, docs, states, config, agent, surface, server, settings, at } = input;
  const pick = pickNext('design', docs, states, config);
  if (pick.id === null) return { id: null, outcome: 'idle', message: pick.reason };

  const doc = docs.find(d => d.id === pick.id)!;
  const state = states.find(s => s.id === pick.id)!;

  // 디자인 언어가 정해지지 않았으면 지어내서 그리지 않는다. 에이전트를 부르지 않고 spec 단계로 되돌린다.
  const missing = missingLanguage(input.language);
  if (missing.length) {
    const reason = `디자인 언어가 정해지지 않아 디자인할 수 없습니다. ${missing.join(', ')}이(가) 없거나 비어 있습니다.`;
    return { id: doc.id, outcome: 'returned', message: reason, state: apply(state, 'returnToSpec', 'design', { reason }, at) };
  }

  const run = await agent({
    prompt: buildPrompt(input, doc, state),
    schema: DESIGN_OUTPUT_SCHEMA,
    cwd: root,
    // html은 저장소에 파일을 쓴다. 디자인 도구에 그릴 때는 저장소를 고칠 일이 없다.
    access: surface === 'html' ? 'write-files' : 'read-only',
    ...(server ? { mcp: [server] } : {}),
    ...settings,
  });
  const result = { id: doc.id, run };

  if (!run.ok) return { ...result, outcome: 'agent-failed', message: `에이전트 실패(${run.reason}): ${run.detail}` };

  const checked = checkDesignOutput(run.output, {
    spec: readSpec(root, doc.id)!, surface, root,
    feedback: designFeedback(state).map(f => f.message),
  });
  if (!checked.ok) {
    return { ...result, outcome: 'invalid-output', message: `디자인 초안이 검사를 통과하지 못했습니다.\n${checked.errors.join('\n')}` };
  }
  if (checked.kind === 'question') {
    const question = joinQuestions(checked.questions);
    return { ...result, outcome: 'question', message: question, state: apply(state, 'ask', 'design', { question }, at) };
  }
  // 초안 요약을 저장소에 쓰고, 디자인 폴더의 해시에 승인을 묶는다.
  writeDesign(root, doc.id, { ...checked.design, surface, specHash: specHash(root, doc.id)! });
  const drafted = apply(state, 'draftDesign', 'design', { designHash: designHash(root, doc.id)! }, at);
  return { ...result, outcome: 'drafted', message: `디자인 초안 제출(${surface}): ${checked.design.summary}\n보기: ${checked.design.location}`, state: drafted };
};
