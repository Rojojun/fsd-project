import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirHash } from './spec.ts';
import type { SavedDesign } from './design.ts';
import type { SavedSpec } from './spec.ts';

/** 요구사항 하나의 E2E 테스트가 놓이는 자리. QA가 쓰고, dev는 고칠 수 없다. */
export const e2ePath = (id: string) => `e2e/${id}`;
export const e2eHash = (root: string, id: string): string | null => dirHash(join(root, e2ePath(id)));

/**
 * 검사 하나. 어디를(target, screen), 무엇을 근거로(basis, covers), 어떻게(steps, expected) 검사하는지 적는다.
 * basis: acceptance는 인수 조건, ui·ux는 디자인 언어의 기준에서 나온 검사다.
 */
export type Scenario = Readonly<{
  id: string;
  target: 'api' | 'screen';
  /** 화면 시나리오가 검사하는 디자인의 화면 이름. api면 빈 문자열 */
  screen: string;
  covers: readonly string[];
  basis: 'acceptance' | 'ui' | 'ux';
  title: string;
  steps: string;
  expected: string;
  /** 이 시나리오를 구현한 테스트 파일 */
  file: string;
}>;
/** 테스트 파일 없이 검증 명령(verify.command) 자체가 확인하는 인수 조건. 예: 타입 오류 0, 기존 테스트 전체 통과 */
export type ByCommand = Readonly<{ id: string; reason: string }>;
export type QaPlan = Readonly<{ summary: string; scenarios: readonly Scenario[]; byCommand?: readonly ByCommand[] }>;

const text = { type: 'string' };
const strict = (properties: Record<string, object>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

/** QA 에이전트가 돌려줘야 하는 형식 */
export const QA_OUTPUT_SCHEMA = strict({
  status: { type: 'string', enum: ['done', 'question'] },
  questions: { type: 'array', items: text },
  plan: {
    anyOf: [
      { type: 'null' },
      strict({
        summary: text,
        scenarios: {
          type: 'array',
          items: strict({
            id: text,
            target: { type: 'string', enum: ['api', 'screen'] },
            screen: text,
            covers: { type: 'array', items: text },
            basis: { type: 'string', enum: ['acceptance', 'ui', 'ux'] },
            title: text,
            steps: text,
            expected: text,
            file: text,
          }),
        },
        byCommand: { type: 'array', items: strict({ id: text, reason: text }) },
      }),
    ],
  },
});

export type QaCheck =
  | { ok: true; kind: 'question'; questions: string[] }
  | { ok: true; kind: 'done'; plan: QaPlan }
  | { ok: false; errors: string[] };

const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const duplicates = (ids: string[]) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];

/**
 * QA 계획을 코드로 대조한다. "어디어디를 검사해야 하는가"의 빠짐을 여기서 잡는다.
 * - 인수 조건마다 검사하는 시나리오가 있는가
 * - (디자인이 있으면) 디자인의 화면마다 화면 시나리오가 있는가
 * - (디자인이 있으면) 화면에 드러나는 인수 조건을 화면에서 검사하는가
 * - (디자인이 있으면) UX 기준에서 나온 검사가 있는가
 * - 시나리오마다 실제 테스트 파일이 E2E 폴더에 있는가
 */
export const checkQaPlan = (
  output: unknown,
  { spec, design, root, command }: Readonly<{ spec: SavedSpec; design: SavedDesign | null; root: string; command?: string }>,
): QaCheck => {
  if (!isObject(output)) return { ok: false, errors: ['출력 형식이 객체가 아닙니다.'] };
  const questions = strings(output.questions).filter(filled);
  if (output.status === 'question') {
    return questions.length ? { ok: true, kind: 'question', questions } : { ok: false, errors: ['질문(question)인데 질문이 없습니다.'] };
  }
  if (output.status !== 'done') return { ok: false, errors: ['status는 done 또는 question이어야 합니다.'] };
  if (!isObject(output.plan)) return { ok: false, errors: ['완료(done)에는 plan이 필요합니다.'] };

  const scenarios = Array.isArray(output.plan.scenarios) ? output.plan.scenarios.filter(isObject) : [];
  const dir = e2ePath(spec.id);
  const known = new Set(spec.acceptance.map(a => a.id));
  const onScreen = scenarios.filter(s => s.target === 'screen');
  const coveredBy = (list: readonly Record<string, unknown>[]) => new Set(list.flatMap(s => strings(s.covers)));
  const screenNames = new Set((design?.screens ?? []).map(s => s.name));
  const visible = [...new Set((design?.screens ?? []).flatMap(s => s.covers))];
  const byCommand = Array.isArray(output.plan.byCommand) ? output.plan.byCommand.filter(isObject) : [];
  const commandIds = new Set(byCommand.map(b => String(b.id)));
  const covered = new Set([...coveredBy(scenarios), ...commandIds]);

  const errors = [
    ...(questions.length ? ['완료(done)인데 질문이 남아 있습니다.'] : []),
    ...(filled(output.plan.summary) ? [] : ['plan.summary가 비어 있습니다.']),
    ...(scenarios.length ? [] : ['시나리오가 하나 이상 필요합니다.']),
    ...duplicates(scenarios.map(s => String(s.id))).map(id => `시나리오 ID ${id}이(가) 겹칩니다.`),
    ...scenarios.flatMap(s => [
      ...(['id', 'title', 'steps', 'expected', 'file'] as const).filter(k => !filled(s[k])).map(k => `시나리오 ${String(s.id)}의 ${k}이(가) 비어 있습니다.`),
      ...(s.target === 'api' || s.target === 'screen' ? [] : [`시나리오 ${String(s.id)}의 target은 api 또는 screen이어야 합니다.`]),
      ...(['acceptance', 'ui', 'ux'].includes(String(s.basis)) ? [] : [`시나리오 ${String(s.id)}의 basis는 acceptance, ui, ux 중 하나여야 합니다.`]),
    ]),
    ...[...coveredBy(scenarios)].filter(id => !known.has(id)).map(id => `스펙에 없는 인수 조건 ${id}을(를) 다룬다고 했습니다.`),
    // 검증 명령이 직접 확인하는 조건
    ...(byCommand.length && !filled(command) ? ['검증 명령(verify.command)이 설정되지 않아 byCommand를 쓸 수 없습니다.'] : []),
    ...byCommand.filter(b => !known.has(String(b.id))).map(b => `스펙에 없는 인수 조건 ${String(b.id)}을(를) 검증 명령이 확인한다고 했습니다.`),
    ...byCommand.filter(b => !filled(b.reason)).map(b => `인수 조건 ${String(b.id)}을(를) 검증 명령이 확인하는 이유가 비어 있습니다.`),
    ...spec.acceptance.filter(a => !covered.has(a.id)).map(a => `인수 조건 ${a.id}을(를) 검사하는 시나리오가 없습니다.`),
    // 테스트 파일
    ...[...new Set(scenarios.map(s => String(s.file).replace(/^\.\//, '')).filter(Boolean))].flatMap(file => {
      if (!file.startsWith(`${dir}/`)) return [`테스트 파일은 ${dir} 안에 있어야 합니다: ${file}`];
      return existsSync(join(root, file)) ? [] : [`테스트 파일 ${file}이(가) 없습니다.`];
    }),
    // 화면
    ...(design
      ? [
          ...[...new Set(onScreen.map(s => String(s.screen)))].filter(n => !screenNames.has(n)).map(n => `디자인에 없는 화면 "${n}"을(를) 검사한다고 했습니다.`),
          ...[...screenNames].filter(n => !onScreen.some(s => s.screen === n)).map(n => `디자인의 "${n}" 화면을 검사하는 화면 시나리오가 없습니다.`),
          ...visible.filter(id => known.has(id) && !coveredBy(onScreen).has(id)).map(id => `인수 조건 ${id}은(는) 화면에 드러나는 조건입니다. 화면에서 검사하는 시나리오가 필요합니다.`),
          ...(onScreen.some(s => s.basis === 'ux') ? [] : ['디자인이 있으면 UX 기준에서 나온 화면 시나리오가 하나 이상 필요합니다.']),
        ]
      : onScreen.length
        ? [`디자인이 없는 요구사항인데 화면 시나리오(${onScreen.map(s => String(s.id)).join(', ')})가 있습니다.`]
        : []),
  ];
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    kind: 'done',
    plan: {
      summary: output.plan.summary as string,
      scenarios: scenarios as unknown as Scenario[],
      byCommand: byCommand.map(b => ({ id: String(b.id), reason: String(b.reason) })),
    },
  };
};

const planFile = (root: string, id: string) => join(root, e2ePath(id), 'qa-plan.json');
const metaFile = (root: string, id: string) => join(root, '.fsd', 'qa', `${id}.json`);

const writeJson = (file: string, value: unknown) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
};

/** 계획은 테스트와 같은 폴더에 둔다. 계획과 테스트가 하나의 해시로 묶인다. */
export const writeQaPlan = (root: string, id: string, plan: QaPlan) => {
  mkdirSync(join(root, e2ePath(id)), { recursive: true });
  writeJson(planFile(root, id), plan);
};

export const readQaPlan = (root: string, id: string): QaPlan | null =>
  existsSync(planFile(root, id)) ? (JSON.parse(readFileSync(planFile(root, id), 'utf8')) as QaPlan) : null;

/** 계획이 어느 스펙·디자인을 보고 쓰였는지, 그리고 QA가 쓴 직후의 E2E 폴더 해시 */
export type QaMeta = Readonly<{ specHash: string | null; designHash: string | null; e2eHash: string | null }>;

export const writeQaMeta = (root: string, id: string, meta: QaMeta) => {
  mkdirSync(join(root, '.fsd', 'qa'), { recursive: true });
  writeJson(metaFile(root, id), meta);
};

export const readQaMeta = (root: string, id: string): QaMeta | null =>
  existsSync(metaFile(root, id)) ? (JSON.parse(readFileSync(metaFile(root, id), 'utf8')) as QaMeta) : null;

const BASIS = { acceptance: '', ui: ' · UI 기준', ux: ' · UX 기준' } as const;

/** 사람이 읽을 검사 계획: 인수 조건과 화면마다 어느 시나리오가 검사하는지 */
export const renderQaPlan = (plan: QaPlan, spec: SavedSpec, design: SavedDesign | null): string => {
  const where = (s: Scenario) => (s.target === 'screen' ? `화면: ${s.screen}` : 'API');
  const ids = (list: readonly Scenario[]) => list.map(s => s.id).join(', ') || '없음';
  return [
    `## 검사 계획\n\n${plan.summary}`,
    `### 인수 조건별\n\n${spec.acceptance
      .map(a => {
        const byCmd = (plan.byCommand ?? []).find(b => b.id === a.id);
        const found = plan.scenarios.filter(s => s.covers.includes(a.id)).map(s => `${s.id} [${where(s)}]`);
        return `- ${a.id} (${a.then}): ${[...found, ...(byCmd ? [`검증 명령 (${byCmd.reason})`] : [])].join(', ') || '없음'}`;
      })
      .join('\n')}`,
    design ? `### 화면별\n\n${design.screens.map(sc => `- ${sc.name}: ${ids(plan.scenarios.filter(s => s.screen === sc.name))}`).join('\n')}` : '',
    `### 시나리오\n\n${plan.scenarios
      .map(s => `- **${s.id}** [${where(s)}${BASIS[s.basis]}] ${s.title}\n  - 절차: ${s.steps}\n  - 기대: ${s.expected}\n  - 파일: ${s.file}`)
      .join('\n')}`,
  ].filter(Boolean).join('\n\n');
};

const KEEP_LINES = 60;

/** 테스트 도구들이 실패를 알리는 줄: Playwright의 "N failed"와 그 아래 목록, node:test의 "not ok", 흔한 실패 기호 */
const failureSummary = (lines: readonly string[]): string[] => {
  const start = lines.findIndex(l => /^\s*\d+ failed\b/.test(l));
  const playwright = start < 0 ? [] : [lines[start], ...lines.slice(start + 1).filter((l, i, rest) => rest.slice(0, i + 1).every(x => /^\s{2,}\S/.test(x) && !/^\s*\d+ (passed|skipped|flaky)\b/.test(x)))];
  const others = lines.filter(l => /^\s*(not ok\b|✘|✗|FAIL\b)/.test(l));
  return [...new Set([...playwright, ...others].map(l => l.trim()))];
};

/**
 * 실패 출력에서 실행할 때마다 바뀌는 부분을 지운다.
 * 같은 실패가 같은 증거가 되어야 반복을 알아챌 수 있다(flags의 sameFailureStreak).
 * 실패한 테스트의 목록을 맨 앞에 둔다. 출력이 길어 끝부분만 남겨도 무엇이 실패했는지는 남는다.
 */
export const normalizeEvidence = (output: string, root: string): string => {
  const lines = output
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replaceAll(`/private${root}`, '.')
    .replaceAll(root, '.')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<시각>')
    // 실행 시간: "(12.5ms)", "(1.2s)", "duration_ms 104.2". 설정값("timeout of 30000ms")은 남긴다.
    .replace(/\s*\(\d+(\.\d+)?\s?m?s\)/g, '')
    .replace(/(duration_ms)\s+\d+(\.\d+)?/g, '$1')
    .split('\n')
    .map(line => line.trimEnd());
  const summary = failureSummary(lines);
  const rest = lines
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .slice(-(KEEP_LINES - summary.length));
  return [...summary, ...(summary.length ? [''] : []), ...rest].join('\n').trim();
};
