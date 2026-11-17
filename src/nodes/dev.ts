import { readDesign, renderDesign } from '../design.ts';
import { designHash } from '../design.ts';
import { appendNote, readNotes } from '../notes.ts';
import { e2eHash, e2ePath } from '../qa.ts';
import { pickNext } from '../select.ts';
import { readSpec, renderSpec, specHash } from '../spec.ts';
import { apply, TransitionError } from '../transitions.ts';
import { joinQuestions, section } from './spec.ts';
import type { Agent } from '../agents/types.ts';
import type { DesignLanguage } from '../design.ts';
import type { RequirementDoc, RequirementState } from '../model.ts';
import type { Config } from '../select.ts';
import type { AgentSettings, TickResult } from './spec.ts';

/** full: 디자인이 없는 요구사항을 혼자 구현. backend·frontend: 디자인이 있는 요구사항을 나눠 동시에 구현. */
export type DevPart = 'full' | 'backend' | 'frontend';
const LABEL: Record<DevPart, string> = { full: '구현', backend: '백엔드', frontend: '프론트엔드' };

export type DevTickInput = Readonly<{
  root: string;
  docs: readonly RequirementDoc[];
  states: readonly RequirementState[];
  config: Config;
  agents: Readonly<Record<DevPart, Agent>>;
  settings: AgentSettings;
  /** 부분별로 다른 모델을 쓸 때 */
  models?: Readonly<Partial<Record<DevPart, string>>>;
  /** 구현 규칙 문서(skills/dev.md)의 내용 */
  skill: string;
  /** 나눠 구현할 때 각자의 범위(skills/dev-backend.md, dev-frontend.md) */
  partGuides: Readonly<{ backend: string; frontend: string }>;
  language: DesignLanguage;
  at: string;
}>;

const text = { type: 'string' };
/** 구현 에이전트가 돌려줘야 하는 형식 */
export const DEV_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'questions', 'summary', 'files', 'notes'],
  properties: {
    status: { type: 'string', enum: ['done', 'question'] },
    questions: { type: 'array', items: text },
    summary: text,
    files: { type: 'array', items: text },
    notes: text,
  },
};

type DevOutput = Readonly<{ status: 'done' | 'question'; questions: string[]; summary: string; files: string[]; notes: string }>;

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const parse = (output: unknown): DevOutput | string => {
  const o = output as Partial<DevOutput> | null;
  if (typeof o !== 'object' || o === null) return '출력 형식이 객체가 아닙니다.';
  if (o.status !== 'done' && o.status !== 'question') return 'status는 done 또는 question이어야 합니다.';
  const questions = isStrings(o.questions) ? o.questions.filter(q => q.trim()) : [];
  if (o.status === 'question' && questions.length === 0) return '질문(question)인데 질문이 없습니다.';
  if (o.status === 'done' && questions.length > 0) return '완료(done)인데 질문이 남아 있습니다.';
  if (o.status === 'done' && !(typeof o.summary === 'string' && o.summary.trim())) return '완료(done)에는 summary가 필요합니다.';
  return { status: o.status, questions, summary: o.summary ?? '', files: isStrings(o.files) ? o.files : [], notes: typeof o.notes === 'string' ? o.notes : '' };
};

/** 구현이 고치면 안 되는 곳. 기준이 되는 문서와 검증 수단이다. */
const PROTECTED = ['requirements/', 'policies/', 'design/', 'specs/', 'designs/', 'e2e/', '.fsd/'];

const buildPrompt = (input: DevTickInput, doc: RequirementDoc, state: RequirementState, part: DevPart): string => {
  const { root, docs, skill, partGuides, language } = input;
  const design = state.approvedDesignHash !== null ? readDesign(root, doc.id) : null;
  const seesDesign = design && part !== 'backend';
  const dependencies = doc.depends.flatMap(id => {
    const dep = readSpec(root, id);
    return dep ? [`## ${id} ${docs.find(d => d.id === id)?.title ?? ''}\n\n${renderSpec(dep)}`] : [];
  });
  return [
    skill.trim(),
    part === 'full' ? '' : partGuides[part].trim(),
    section('요구사항', `ID: ${doc.id}\n제목: ${doc.title}\n\n${doc.body}`),
    section('확정된 스펙 (이대로 구현한다)', renderSpec(readSpec(root, doc.id)!)),
    section('사람이 이미 내린 결정', state.decisions.map(d => `- 질문: ${d.question}\n  답: ${d.answer}`).join('\n')),
    section('확정된 디자인 (이대로 만든다)', seesDesign ? renderDesign(design) : ''),
    section('UI 기준 (design/ui.md)', seesDesign ? language.ui ?? '' : ''),
    section('UX 기준 (design/ux.md)', seesDesign ? language.ux ?? '' : ''),
    section('선행 요구사항의 확정 스펙', dependencies.join('\n\n')),
    section('고쳐야 할 버그 (E2E가 실패했다)', state.bug ? state.bug.evidence : ''),
    section('이전 실행이 남긴 인계 메모', readNotes(root, doc.id)),
    section('고치면 안 되는 곳', PROTECTED.map(p => `- \`${p}\``).join('\n')),
  ].filter(Boolean).join('\n\n---\n\n');
};

const normalize = (file: string) => file.trim().replace(/^\.\//, '');
const shared = (a: readonly string[], b: readonly string[]) => {
  const other = new Set(b.map(normalize));
  return [...new Set(a.map(normalize))].filter(f => other.has(f));
};

/**
 * dev 노드의 한 사이클: 후보 하나를 구현한다.
 * 디자인이 있는 요구사항은 백엔드와 프론트엔드로 나눠 동시에 실행한다. 둘을 잇는 것은 확정된 스펙의 계약이다.
 */
export const tickDev = async (input: DevTickInput): Promise<TickResult> => {
  const { root, docs, states, config, agents, settings, models, at } = input;
  const pick = pickNext('dev', docs, states, config);
  if (pick.id === null) return { id: null, outcome: 'idle', message: pick.reason };

  const doc = docs.find(d => d.id === pick.id)!;
  const picked = states.find(s => s.id === pick.id)!;
  // 착수는 먼저 기록한다. 에이전트가 중간에 끊겨도 다음 사이클이 이어서 한다.
  const state = picked.status === 'in-dev' ? picked : apply(picked, 'startDev', 'dev', {}, at);
  const parts: DevPart[] = state.approvedDesignHash !== null ? ['backend', 'frontend'] : ['full'];
  const e2eBefore = e2eHash(root, doc.id);

  const runs = await Promise.all(
    parts.map(async part => ({
      part,
      run: await agents[part]({
        prompt: buildPrompt(input, doc, state, part),
        schema: DEV_OUTPUT_SCHEMA,
        cwd: root,
        access: 'workspace-write',
        ...settings,
        ...(models?.[part] ? { model: models[part] } : {}),
      }),
    })),
  );
  const result = { id: doc.id, runs, state };
  const stay = (outcome: 'invalid-output' | 'agent-failed', message: string): TickResult => ({ ...result, outcome, message });

  const failed = runs.filter(r => !r.run.ok);
  const outputs = runs.flatMap(({ part, run }) => (run.ok ? [{ part, output: parse(run.output) }] : []));
  // 실패한 쪽이 있어도 끝난 쪽의 메모는 남긴다.
  outputs.forEach(({ part, output }) => typeof output !== 'string' && appendNote(root, doc.id, at, LABEL[part], output.notes));

  if (failed.length) {
    return stay('agent-failed', failed.map(({ part, run }) => `${LABEL[part]} 에이전트 실패(${run.ok ? '' : run.reason}): ${run.ok ? '' : run.detail}`).join('\n'));
  }
  const broken = outputs.filter((o): o is { part: DevPart; output: string } => typeof o.output === 'string');
  if (broken.length) return stay('invalid-output', broken.map(o => `${LABEL[o.part]}: ${o.output}`).join('\n'));
  const done = outputs as { part: DevPart; output: DevOutput }[];

  const asking = done.filter(o => o.output.status === 'question');
  if (asking.length) {
    const question = joinQuestions(asking.flatMap(o => o.output.questions.map(q => (parts.length > 1 ? `[${LABEL[o.part]}] ${q}` : q))));
    return { ...result, outcome: 'question', message: question, state: apply(state, 'ask', 'dev', { question }, at) };
  }

  if (done.length === 2) {
    const both = shared(done[0].output.files, done[1].output.files);
    if (both.length) return stay('invalid-output', `백엔드와 프론트엔드가 같은 파일을 고쳤습니다: ${both.join(', ')}. 한쪽만 맡아야 합니다.`);
  }
  if (e2eHash(root, doc.id) !== e2eBefore) {
    return stay('invalid-output', `구현이 E2E 테스트(${e2ePath(doc.id)})를 고쳤습니다. 테스트는 QA만 고칩니다.`);
  }

  try {
    const implemented = apply(state, 'finishDev', 'dev', {
      specHash: specHash(root, doc.id) ?? '',
      ...(state.approvedDesignHash !== null ? { designHash: designHash(root, doc.id) ?? '' } : {}),
    }, at);
    const summary = done.map(o => (parts.length > 1 ? `[${LABEL[o.part]}] ${o.output.summary}` : o.output.summary)).join('\n');
    return { ...result, outcome: 'implemented', message: summary, state: implemented };
  } catch (e) {
    if (!(e instanceof TransitionError)) throw e;
    return stay('invalid-output', e.message);
  }
};
