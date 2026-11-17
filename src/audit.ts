import { renderSpec } from './spec.ts';
import type { RequirementDoc, RequirementState } from './model.ts';
import type { SavedSpec } from './spec.ts';

/**
 * audit: 확정된 스펙들을 함께 읽고, 하나씩 보면 맞지만 합치면 어긋나는 곳을 찾는다.
 * 지적마다 스펙 원문을 인용하게 하고, 인용이 실제로 있는지 코드가 대조한다. 지어낸 지적은 버린다.
 */

export const AUDIT_KINDS = ['contradiction', 'duplicate', 'invalid-reference'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
export const KIND_LABEL: Record<AuditKind, string> = {
  contradiction: '교차 모순',
  duplicate: '의미 중복',
  'invalid-reference': '무효 근거',
};

export type Finding = Readonly<{
  kind: AuditKind;
  /** 관련된 요구사항 */
  requirements: readonly string[];
  /** 고칠 요구사항. requirements 가운데 하나 */
  fixIn: string;
  summary: string;
  /** 요구사항마다 하나 이상, 그 요구사항의 글에서 그대로 옮긴 인용 */
  evidence: readonly Readonly<{ id: string; quote: string }>[];
  suggestion: string;
}>;

const text = { type: 'string' };
/** audit 에이전트가 돌려줘야 하는 형식 */
export const AUDIT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'requirements', 'fixIn', 'summary', 'evidence', 'suggestion'],
        properties: {
          kind: { type: 'string', enum: [...AUDIT_KINDS] },
          requirements: { type: 'array', items: text },
          fixIn: text,
          summary: text,
          evidence: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['id', 'quote'], properties: { id: text, quote: text } },
          },
          suggestion: text,
        },
      },
    },
  },
};

/** audit이 읽는 요구사항 하나의 글: 요구사항 본문과 확정 스펙. 인용은 이 글에서 대조한다. */
export const specText = (doc: RequirementDoc, spec: SavedSpec) =>
  `# ${doc.id} ${doc.title}\n\n## 요구사항\n\n${doc.body}\n\n${renderSpec(spec)}`;

/** 인용 대조용: 띄어쓰기, 마크다운 기호, 문장 부호는 보지 않는다 */
const squash = (s: string) => s.replace(/[\s`*|>#_~"'“”‘’.,:;!?()[\]{}-]/g, '');
const MIN_QUOTE = 4;

export type AuditCheck =
  | { ok: true; findings: Finding[]; rejected: { finding: Finding; reason: string }[] }
  | { ok: false; message: string };

const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

const shapeOk = (f: unknown): f is Finding => {
  const x = f as Partial<Finding> | null;
  return typeof x === 'object' && x !== null && (AUDIT_KINDS as readonly unknown[]).includes(x.kind)
    && Array.isArray(x.requirements) && x.requirements.every(filled) && typeof x.fixIn === 'string'
    && filled(x.summary) && Array.isArray(x.evidence)
    && x.evidence.every(e => typeof e === 'object' && e !== null && typeof e.id === 'string' && typeof e.quote === 'string')
    && typeof x.suggestion === 'string';
};

const problem = (f: Finding, texts: ReadonlyMap<string, string>): string | null => {
  const unknown = f.requirements.filter(id => !texts.has(id));
  if (unknown.length) return `검토 대상이 아닌 요구사항(${unknown.join(', ')})을 들었습니다.`;
  if (f.kind !== 'invalid-reference' && new Set(f.requirements).size < 2) return `${KIND_LABEL[f.kind]}는 요구사항이 둘 이상이어야 합니다.`;
  if (!f.requirements.includes(f.fixIn)) return `고칠 곳(fixIn: ${f.fixIn})이 관련 요구사항 가운데 하나가 아닙니다.`;
  const withoutQuote = f.requirements.filter(id => !f.evidence.some(e => e.id === id));
  if (withoutQuote.length) return `${withoutQuote.join(', ')}의 인용이 없습니다. 관련 요구사항마다 원문 인용이 있어야 합니다.`;
  const bad = f.evidence.find(e => !texts.has(e.id) || squash(e.quote).length < MIN_QUOTE || !squash(texts.get(e.id)!).includes(squash(e.quote)));
  if (bad) return `${bad.id}의 인용 "${bad.quote.slice(0, 60)}"이(가) 그 요구사항의 글에 없습니다.`;
  return null;
};

/** 에이전트의 지적을 대조한다. 잘못된 지적은 하나씩 버리고 이유를 남긴다. */
export const checkAuditOutput = (
  output: unknown,
  { specs, docs }: Readonly<{ specs: Readonly<Record<string, SavedSpec>>; docs: readonly RequirementDoc[] }>,
): AuditCheck => {
  const raw = (output as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(raw)) return { ok: false, message: 'audit 결과의 형식이 다릅니다(findings가 없음).' };
  const texts = new Map(docs.filter(d => specs[d.id]).map(d => [d.id, specText(d, specs[d.id])]));
  const findings: Finding[] = [];
  const rejected: { finding: Finding; reason: string }[] = [];
  for (const f of raw) {
    if (!shapeOk(f)) {
      rejected.push({ finding: f as Finding, reason: '지적의 형식이 다릅니다.' });
      continue;
    }
    const reason = problem(f, texts);
    if (reason) rejected.push({ finding: f, reason });
    else findings.push(f);
  }
  return { ok: true, findings, rejected };
};

/** 같은 지적을 알아보는 키. 질문 글에 [키]로 넣어 둔다. */
export const auditKey = (f: Pick<Finding, 'kind' | 'requirements'>) => `audit:${f.kind}:${[...new Set(f.requirements)].sort().join(',')}`;

/**
 * 이 지적을 올리지 않아야 하는가.
 * - 같은 지적이 이미 질문으로 열려 있다.
 * - 사람이 이미 답했고(문제 아님), 그 뒤로 관련 요구사항의 스펙이 다시 확정되지 않았다.
 */
export const isSuppressed = (key: string, requirements: readonly string[], states: readonly RequirementState[]): boolean => {
  const mark = `[${key}]`;
  if (states.some(s => s.holds.some(h => h.raisedBy === 'audit' && h.message.includes(mark)))) return true;
  const answeredAt = states.flatMap(s => s.decisions.filter(d => d.question.includes(mark)).map(d => d.at)).sort().at(-1);
  if (!answeredAt) return false;
  const respecifiedAfter = states
    .filter(s => requirements.includes(s.id))
    .some(s => s.history.some(h => h.transition === 'approveSpec' && h.at > answeredAt));
  return !respecifiedAfter;
};

export const formatFinding = (f: Finding) =>
  [
    `[${auditKey(f)}] ${KIND_LABEL[f.kind]}: ${f.summary}`,
    '근거:',
    ...f.evidence.map(e => `- ${e.id}: "${e.quote}"`),
    f.suggestion.trim() ? `제안: ${f.suggestion}` : '',
  ].filter(Boolean).join('\n');
