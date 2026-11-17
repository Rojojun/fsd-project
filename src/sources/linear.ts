import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { Agent, AgentResult } from '../agents/types.ts';

/**
 * 입력 어댑터: Linear 이슈를 요구사항 파일로 옮겨 적는다.
 *
 * Linear가 원본이고 requirements/<식별자>.md는 그 사본이다. 사본을 두는 이유는 두 가지다.
 * 뒤의 모든 단계(변경 감지, 스펙, 구현, 검증)가 저장소의 파일만 보고 돌 수 있고,
 * "어느 내용을 보고 스펙을 썼는가"가 커밋으로 남는다.
 * 옮겨 적는 일만 한다. 요약하거나 고쳐 쓰지 않는다.
 */

export type LinearIssue = Readonly<{
  identifier: string;
  title: string;
  /** Linear의 우선순위: 0 없음, 1 긴급, 2 높음, 3 보통, 4 낮음 */
  priority: number;
  /** Linear 상태의 종류: triage, backlog, unstarted, started, completed, canceled */
  stateType: string;
  labels: readonly string[];
  /** 이 이슈를 막고 있는 이슈의 식별자 */
  blockedBy: readonly string[];
  description: string;
  url: string;
}>;

export type LinearFilter = Readonly<{ team?: string; project?: string; label?: string; states?: readonly string[] }>;

const text = { type: 'string' };
/** Linear를 읽는 에이전트가 돌려줘야 하는 형식 */
export const LINEAR_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['identifier', 'title', 'priority', 'stateType', 'labels', 'blockedBy', 'description', 'url'],
        properties: {
          identifier: text, title: text, priority: { type: 'number' }, stateType: text,
          labels: { type: 'array', items: text }, blockedBy: { type: 'array', items: text },
          description: text, url: text,
        },
      },
    },
  },
};

const PRIORITY = ['P2', 'P0', 'P0', 'P1', 'P2'] as const;
const POLICY_LABEL = /^policy:(.+)$/;
const SOURCE_MARK = /^source: linear$/m;

/** 이슈 하나를 요구사항 파일로. 같은 이슈는 언제나 같은 글자가 된다(지문이 흔들리지 않게). */
export const toRequirementFile = (issue: LinearIssue, pulled: ReadonlySet<string>) => {
  const labels = issue.labels.map(l => l.trim());
  const design = labels.includes('design') ? true : labels.includes('no-design') ? false : null;
  const front = {
    id: issue.identifier,
    title: issue.title,
    priority: PRIORITY[issue.priority] ?? 'P2',
    depends: issue.blockedBy.filter(id => pulled.has(id)).sort(),
    policies: labels.flatMap(l => POLICY_LABEL.exec(l)?.[1] ?? []).sort(),
    ...(design === null ? {} : { design }),
    ...(issue.stateType === 'canceled' ? { deprecated: true } : {}),
    source: 'linear',
    url: issue.url,
  };
  return {
    name: `${issue.identifier}.md`,
    // 안내는 머리말의 주석으로 둔다. 본문에 넣으면 요구사항의 일부로 읽힌다.
    text: `---\n# Linear에서 가져온 사본이다. 내용은 Linear에서 고친다. 여기서 고치면 다음에 가져올 때 덮어쓴다.\n${stringify(front).trimEnd()}\n---\n${issue.description.trim()}\n`,
  };
};

export type PullInput = Readonly<{
  root: string;
  agent: Agent;
  /** Linear MCP 서버의 이름 */
  server: string;
  settings: Readonly<{ timeoutMs: number; maxTurns: number; model?: string }>;
  /** 읽는 규칙 문서(skills/linear-reader.md)의 내용 */
  skill: string;
  filter: LinearFilter;
  dryRun: boolean;
}>;

export type PullResult =
  | Readonly<{
      ok: true;
      created: string[];
      changed: string[];
      unchanged: string[];
      /** 옮겨 적지 않은 이슈와 이유 */
      skipped: { id: string; reason: string }[];
      /** 전에 가져왔는데 이번에는 오지 않은 이슈. 파일은 그대로 둔다 */
      missing: string[];
      run: AgentResult;
    }>
  | Readonly<{ ok: false; message: string; run?: AgentResult }>;

const describeFilter = (f: LinearFilter) =>
  [
    f.team && `- 팀: ${f.team}`,
    f.project && `- 프로젝트: ${f.project}`,
    f.label && `- 라벨: ${f.label}`,
    f.states?.length && `- 상태: ${f.states.join(', ')} (이 상태의 이슈만. 취소된 이슈는 상태와 무관하게 함께 가져온다)`,
  ].filter(Boolean).join('\n');

const IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;
const isIssue = (v: unknown): v is LinearIssue => {
  const i = v as Partial<LinearIssue> | null;
  return typeof i === 'object' && i !== null && typeof i.identifier === 'string' && typeof i.title === 'string'
    && typeof i.priority === 'number' && typeof i.stateType === 'string' && typeof i.description === 'string'
    && typeof i.url === 'string' && Array.isArray(i.labels) && Array.isArray(i.blockedBy);
};

const invalid = (issue: LinearIssue): string | null => {
  if (!IDENTIFIER.test(issue.identifier)) return '이슈 식별자 형식이 아닙니다.';
  if (!issue.title.trim()) return '제목이 없습니다.';
  if (!issue.description.trim()) return '본문(설명)이 없습니다. Linear에서 요구사항을 적어야 합니다.';
  return null;
};

/** Linear의 이슈를 읽어 requirements/ 에 옮겨 적는다. 지우는 일은 하지 않는다. */
export const pullLinear = async (input: PullInput): Promise<PullResult> => {
  const { root, agent, server, settings, skill, filter, dryRun } = input;
  const run = await agent({
    prompt: `${skill.trim()}\n\n---\n\n# 가져올 범위\n\n${describeFilter(filter)}`,
    schema: LINEAR_OUTPUT_SCHEMA,
    cwd: root,
    access: 'read-only',
    mcp: [server],
    ...settings,
  });
  if (!run.ok) return { ok: false, message: `Linear를 읽는 에이전트 실패(${run.reason}): ${run.detail}`, run };

  const raw = (run.output as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(raw) || !raw.every(isIssue)) return { ok: false, message: 'Linear를 읽은 결과의 형식이 다릅니다.', run };

  const dir = join(root, 'requirements');
  const read = (id: string) => (existsSync(join(dir, `${id}.md`)) ? readFileSync(join(dir, `${id}.md`), 'utf8') : null);
  const usable = raw.filter(i => invalid(i) === null);
  const pulled = new Set(usable.map(i => i.identifier));

  const result = { created: [] as string[], changed: [] as string[], unchanged: [] as string[] };
  const skipped = raw.flatMap(i => (invalid(i) ? [{ id: i.identifier, reason: invalid(i)! }] : []));
  const writes: { name: string; text: string }[] = [];

  for (const issue of usable) {
    const file = toRequirementFile(issue, pulled);
    const existing = read(issue.identifier);
    if (existing !== null && !SOURCE_MARK.test(existing)) {
      skipped.push({ id: issue.identifier, reason: '같은 ID로 사람이 직접 쓴 요구사항 파일이 있어 덮어쓰지 않았습니다.' });
    } else if (existing === file.text) {
      result.unchanged.push(issue.identifier);
    } else {
      (existing === null ? result.created : result.changed).push(issue.identifier);
      writes.push(file);
    }
  }

  const before = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)) : [];
  const missing = before.filter(id => !pulled.has(id) && SOURCE_MARK.test(read(id) ?? '')).sort();

  if (!dryRun && writes.length) {
    mkdirSync(dir, { recursive: true });
    writes.forEach(file => writeFileSync(join(dir, file.name), file.text));
  }
  return { ok: true, ...result, skipped, missing, run };
};
