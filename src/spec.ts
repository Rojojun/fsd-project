import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprint } from './catalog.ts';
import type { RequirementDoc } from './model.ts';

export type Acceptance = Readonly<{ id: string; given: string; when: string; then: string }>;
export type PolicyUse = Readonly<{ id: string; applied: string }>;
export type Spec = Readonly<{
  summary: string;
  contract: string;
  acceptance: readonly Acceptance[];
  policies: readonly PolicyUse[];
}>;
/** 저장된 스펙. 어느 요구사항 내용을 보고 썼는지(reqHash) 함께 남긴다. */
export type SavedSpec = Spec & Readonly<{ id: string; reqHash: string }>;

const text = { type: 'string' };
const strict = (properties: Record<string, object>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

/** 스펙 작성 에이전트가 돌려줘야 하는 형식 */
export const SPEC_OUTPUT_SCHEMA = strict({
  status: { type: 'string', enum: ['done', 'question'] },
  questions: { type: 'array', items: text },
  spec: {
    anyOf: [
      { type: 'null' },
      strict({
        summary: text,
        contract: text,
        acceptance: { type: 'array', items: strict({ id: text, given: text, when: text, then: text }) },
        policies: { type: 'array', items: strict({ id: text, applied: text }) },
      }),
    ],
  },
});

export type SpecCheck =
  | { ok: true; kind: 'question'; questions: string[] }
  | { ok: true; kind: 'done'; spec: Spec }
  | { ok: false; errors: string[] };

const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const duplicates = (ids: string[]) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];

const normalize = (v: unknown) => String(v).replace(/[\s.]/g, '');
/** 행동 칸에 결과 문장이 통째로 들어 있는가 */
const repeatsResult = (a: Record<string, unknown>) =>
  filled(a.when) && filled(a.then) && normalize(a.when).includes(normalize(a.then));

const specErrors = (spec: unknown, doc: RequirementDoc): string[] => {
  if (!isObject(spec)) return ['완료(done)에는 spec이 필요합니다.'];
  const acceptance = Array.isArray(spec.acceptance) ? spec.acceptance.filter(isObject) : [];
  const policies = Array.isArray(spec.policies) ? spec.policies.filter(isObject) : [];
  const cited = policies.map(p => String(p.id));
  return [
    !filled(spec.summary) && 'spec.summary가 비어 있습니다.',
    !filled(spec.contract) && 'spec.contract가 비어 있습니다.',
    acceptance.length === 0 && '인수 조건이 하나 이상 필요합니다.',
    ...acceptance.flatMap((a, i) =>
      (['id', 'given', 'when', 'then'] as const).filter(k => !filled(a[k])).map(k => `인수 조건 ${i + 1}번의 ${k}이(가) 비어 있습니다.`)),
    ...duplicates(acceptance.map(a => String(a.id))).map(id => `인수 조건 ID ${id}이(가) 겹칩니다.`),
    ...acceptance.filter(repeatsResult).map(a => `인수 조건 ${String(a.id)}: 행동(when)에 결과(then)를 되풀이해 썼습니다. 행동에는 하는 일만 적습니다.`),
    ...doc.policies.filter(id => !cited.includes(id)).map(id => `요구사항이 근거로 든 정책 ${id}을(를) 스펙이 다루지 않았습니다.`),
    ...cited.filter(id => !doc.policies.includes(id)).map(id => `요구사항에 없는 정책 ${id}을(를) 인용했습니다.`),
    ...policies.filter(p => !filled(p.applied)).map(p => `정책 ${String(p.id)}을(를) 어떻게 적용했는지 비어 있습니다.`),
  ].filter((e): e is string => typeof e === 'string');
};

/** 에이전트 출력을 코드로 검사한다. 어떤 모델이 썼든 같은 기준을 통과해야 한다. */
export const checkSpecOutput = (output: unknown, doc: RequirementDoc): SpecCheck => {
  if (!isObject(output)) return { ok: false, errors: ['출력 형식이 객체가 아닙니다.'] };
  const questions = Array.isArray(output.questions) ? output.questions.filter(filled) : [];

  if (output.status === 'question') {
    return questions.length ? { ok: true, kind: 'question', questions } : { ok: false, errors: ['질문(question)인데 질문이 없습니다.'] };
  }
  if (output.status !== 'done') return { ok: false, errors: ['status는 done 또는 question이어야 합니다.'] };

  const errors = [
    ...(questions.length ? ['완료(done)인데 질문이 남아 있습니다. 질문이 있으면 question으로 돌려줘야 합니다.'] : []),
    ...specErrors(output.spec, doc),
  ];
  return errors.length ? { ok: false, errors } : { ok: true, kind: 'done', spec: output.spec as Spec };
};

const specDir = (root: string, id: string) => join(root, 'specs', id);

export const writeSpec = (root: string, doc: RequirementDoc, spec: Spec) => {
  const dir = specDir(root, doc.id);
  mkdirSync(dir, { recursive: true });
  const saved: SavedSpec = { id: doc.id, reqHash: doc.hash, ...spec };
  const file = join(dir, 'spec.json');
  writeFileSync(`${file}.tmp`, JSON.stringify(saved, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
};

export const readSpec = (root: string, id: string): SavedSpec | null => {
  const file = join(specDir(root, id), 'spec.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as SavedSpec) : null;
};

/** 스펙 폴더 전체의 지문. 승인과 Spec Gate가 이 값에 묶인다. 폴더 안의 무엇이 바뀌어도 달라진다. */
export const specHash = (root: string, id: string): string | null => {
  const dir = specDir(root, id);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => !f.endsWith('.tmp')).sort();
  if (files.length === 0) return null;
  return fingerprint(files.map(f => `${f}\0${readFileSync(join(dir, f), 'utf8')}`).join('\0'));
};

/** 사람이 승인 전에 읽을 문서 */
export const renderSpec = (spec: Spec): string =>
  [
    `## 요약\n\n${spec.summary}`,
    `## 계약\n\n${spec.contract}`,
    `## 인수 조건\n\n${spec.acceptance
      .map(a => `- **${a.id}**\n  - 조건: ${a.given}\n  - 행동: ${a.when}\n  - 결과: ${a.then}`)
      .join('\n')}`,
    spec.policies.length ? `## 적용한 정책\n\n${spec.policies.map(p => `- **${p.id}**: ${p.applied}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
