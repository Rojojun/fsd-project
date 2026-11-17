import { execProcess } from '../agents/exec.ts';
import { designHash, readDesign, renderDesign } from '../design.ts';
import { readNotes } from '../notes.ts';
import { checkQaPlan, e2eHash, e2ePath, normalizeEvidence, QA_OUTPUT_SCHEMA, readQaMeta, readQaPlan, writeQaMeta, writeQaPlan } from '../qa.ts';
import { pickNext } from '../select.ts';
import { readSpec, renderSpec, specHash } from '../spec.ts';
import { apply } from '../transitions.ts';
import { joinQuestions, section } from './spec.ts';
import type { Agent, AgentResult, Exec } from '../agents/types.ts';
import type { DesignLanguage } from '../design.ts';
import type { RequirementDoc, RequirementState } from '../model.ts';
import type { Config } from '../select.ts';
import type { AgentSettings, TickResult } from './spec.ts';

export type VerifyTickInput = Readonly<{
  root: string;
  docs: readonly RequirementDoc[];
  states: readonly RequirementState[];
  config: Config;
  /** QA 에이전트. 구현한 에이전트와 다른 호출이다 */
  agent: Agent;
  settings: AgentSettings;
  /** QA 규칙 문서(skills/qa.md)의 내용 */
  skill: string;
  language: DesignLanguage;
  /** 대상 프로젝트의 E2E 실행 명령. {id}는 요구사항 ID로 바뀐다 */
  command: string;
  commandTimeoutMs: number;
  exec?: Exec;
  at: string;
}>;

const buildPrompt = (input: VerifyTickInput, doc: RequirementDoc, state: RequirementState, command: string): string => {
  const { root, skill, language } = input;
  const design = state.approvedDesignHash !== null ? readDesign(root, doc.id) : null;
  const previous = readQaPlan(root, doc.id);
  return [
    skill.trim(),
    section('테스트를 둘 곳과 실행 방법', `테스트 파일은 \`${e2ePath(doc.id)}/\` 안에만 쓴다. 이 폴더 밖의 파일은 고치지 않는다.\n검증은 이 명령으로 실행된다: \`${command}\`\n이 명령으로 네가 쓴 테스트가 모두 실행되어야 한다.`),
    section('요구사항', `ID: ${doc.id}\n제목: ${doc.title}\n\n${doc.body}`),
    section('확정된 스펙 (기대 결과의 근거)', renderSpec(readSpec(root, doc.id)!)),
    section('사람이 이미 내린 결정', state.decisions.map(d => `- 질문: ${d.question}\n  답: ${d.answer}`).join('\n')),
    section('확정된 디자인 (화면 검사의 근거)', design ? renderDesign(design) : ''),
    section('UI 기준 (design/ui.md)', design ? language.ui ?? '' : ''),
    section('UX 기준 (design/ux.md)', design ? language.ux ?? '' : ''),
    section('구현이 남긴 인계 메모 (실행 방법을 아는 데만 쓴다)', readNotes(root, doc.id)),
    section('이전 검사 계획 (스펙이나 디자인이 바뀌어 다시 쓴다)', previous ? JSON.stringify(previous, null, 2) : ''),
  ].filter(Boolean).join('\n\n---\n\n');
};

/**
 * verify 노드의 한 사이클.
 * 1) 이 스펙·디자인에 대한 검사 계획과 E2E가 없으면 QA 에이전트가 쓴다. 계획의 빠짐은 코드가 대조한다.
 * 2) 대상 프로젝트의 테스트 명령을 실행한다. 통과하면 verified, 실패하면 증거와 함께 dev로 되돌린다.
 */
export const tickVerify = async (input: VerifyTickInput): Promise<TickResult> => {
  const { root, docs, states, config, agent, settings, at, exec = execProcess } = input;
  const pick = pickNext('verify', docs, states, config);
  if (pick.id === null) return { id: null, outcome: 'idle', message: pick.reason };

  const doc = docs.find(d => d.id === pick.id)!;
  const state = states.find(s => s.id === pick.id)!;
  const command = input.command.replaceAll('{id}', doc.id);
  const basis = { specHash: specHash(root, doc.id), designHash: state.approvedDesignHash !== null ? designHash(root, doc.id) : null };

  const meta = readQaMeta(root, doc.id);
  const fresh = meta !== null && meta.specHash === basis.specHash && meta.designHash === basis.designHash;
  let run: AgentResult | undefined;

  if (fresh && e2eHash(root, doc.id) !== meta.e2eHash) {
    // QA가 쓴 뒤 누군가 테스트를 고쳤다. 고친 테스트로 통과시키지 않는다.
    const question = `QA가 쓴 뒤에 E2E 테스트(${e2ePath(doc.id)})가 바뀌었습니다. 바뀐 테스트를 인정할지(그러면 .agdd/qa/${doc.id}.json을 지우고 다시 검증), 되돌릴지 알려 주세요.`;
    return { id: doc.id, outcome: 'question', message: question, state: apply(state, 'ask', 'verify', { question }, at) };
  }

  if (!fresh) {
    run = await agent({
      prompt: buildPrompt(input, doc, state, command),
      schema: QA_OUTPUT_SCHEMA,
      cwd: root,
      access: 'workspace-write',
      ...settings,
    });
    if (!run.ok) return { id: doc.id, run, outcome: 'agent-failed', message: `QA 에이전트 실패(${run.reason}): ${run.detail}` };

    const design = state.approvedDesignHash !== null ? readDesign(root, doc.id) : null;
    const checked = checkQaPlan(run.output, { spec: readSpec(root, doc.id)!, design, root });
    if (!checked.ok) {
      return { id: doc.id, run, outcome: 'invalid-output', message: `검사 계획이 대조를 통과하지 못했습니다.\n${checked.errors.join('\n')}` };
    }
    if (checked.kind === 'question') {
      const question = joinQuestions(checked.questions);
      return { id: doc.id, run, outcome: 'question', message: question, state: apply(state, 'ask', 'verify', { question }, at) };
    }
    writeQaPlan(root, doc.id, checked.plan);
    writeQaMeta(root, doc.id, { ...basis, e2eHash: e2eHash(root, doc.id) });
  }

  const test = await exec('sh', ['-c', command], { cwd: root, timeoutMs: input.commandTimeoutMs });
  if (test.code === 0 && !test.timedOut) {
    return { id: doc.id, run, outcome: 'verified', message: `E2E 통과: ${command}`, state: apply(state, 'passVerify', 'verify', {}, at) };
  }
  const evidence = test.timedOut
    ? `E2E가 시간 한도(${input.commandTimeoutMs}ms) 안에 끝나지 않았습니다: ${command}`
    : normalizeEvidence(`${test.stdout}\n${test.stderr}`, root) || `종료 코드 ${test.code}: ${command}`;
  return { id: doc.id, run, outcome: 'failed', message: `E2E 실패: ${command}\n${evidence}`, state: apply(state, 'failVerify', 'verify', { evidence }, at) };
};
