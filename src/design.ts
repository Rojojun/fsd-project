import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execProcess } from './agents/exec.ts';
import { findServer, listServers } from './agents/mcp.ts';
import { ASPECTS } from './model.ts';
import { dirHash } from './spec.ts';
import type { Aspect } from './model.ts';
import type { Exec } from './agents/types.ts';
import type { SavedSpec } from './spec.ts';

/**
 * 디자인을 그리는 곳. 연결되어 있는 도구 가운데 앞에 있는 것을 쓴다.
 * html은 디자인 도구가 하나도 연결되지 않았을 때 Claude가 쓰는 단일 HTML 파일이다(Claude 아티팩트로 그대로 올릴 수 있다).
 */
export const SURFACES = ['penpot', 'figma', 'html'] as const;
export type Surface = (typeof SURFACES)[number];

export type SurfaceChoice = Readonly<{
  surface: Surface;
  /** 이 디자인을 그릴 에이전트 */
  agent: string;
  /** 쓸 MCP 서버 이름. html이면 null */
  server: string | null;
}>;

export { connectedServers } from './agents/mcp.ts';

/**
 * 우선순위: penpot → figma → html.
 * 역할에 지정된 에이전트에 연결된 도구를 먼저 보고, 없으면 claude 쪽 연결을 본다.
 * 어느 쪽에도 디자인 도구가 없으면 역할의 에이전트가 무엇이든 claude가 HTML로 그린다.
 */
export const chooseSurface = async (roleAgent: string, exec: Exec = execProcess): Promise<SurfaceChoice> => {
  const listed = await listServers(roleAgent, exec);
  for (const surface of ['penpot', 'figma'] as const) {
    const found = findServer(listed, surface);
    if (found) return { surface, ...found };
  }
  return { surface: 'html', agent: 'claude', server: null };
};

export type Screen = Readonly<{ name: string; description: string; covers: readonly string[] }>;
/**
 * 사람의 지적을 검사할 수 있는 규칙으로 옮긴 것.
 * scope가 language면 이 디자인에만 해당하지 않는 일반 규칙이다. 디자인이 승인되면 디자인 언어 문서에 쌓인다.
 */
export type Codified = Readonly<{ aspect: Aspect; source: string; rule: string; scope: 'design' | 'language' }>;
export type Design = Readonly<{ summary: string; location: string; screens: readonly Screen[]; codified: readonly Codified[] }>;
/** 저장된 디자인 요약. 어디에 그렸는지, 어느 스펙을 보고 그렸는지 함께 남긴다. */
export type SavedDesign = Design & Readonly<{ surface: Surface; specHash: string }>;

const text = { type: 'string' };
const strict = (properties: Record<string, object>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

/** 디자인 에이전트가 돌려줘야 하는 형식 */
export const DESIGN_OUTPUT_SCHEMA = strict({
  status: { type: 'string', enum: ['done', 'question'] },
  questions: { type: 'array', items: text },
  design: {
    anyOf: [
      { type: 'null' },
      strict({
        summary: text,
        location: text,
        screens: { type: 'array', items: strict({ name: text, description: text, covers: { type: 'array', items: text } }) },
        codified: {
          type: 'array',
          items: strict({
            aspect: { type: 'string', enum: [...ASPECTS] },
            source: text,
            rule: text,
            scope: { type: 'string', enum: ['design', 'language'] },
          }),
        },
      }),
    ],
  },
});

export type DesignCheck =
  | { ok: true; kind: 'question'; questions: string[] }
  | { ok: true; kind: 'done'; design: Design }
  | { ok: false; errors: string[] };

const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const designDir = (root: string, id: string) => join(root, 'designs', id);
/** html 디자인 파일의 자리. 에이전트가 정하지 않고 코드가 정한다. */
export const htmlPath = (id: string) => `designs/${id}/index.html`;

const locationErrors = (design: Record<string, unknown>, surface: Surface, root: string, id: string): string[] => {
  if (surface !== 'html') {
    return /^https?:\/\/\S+$/.test(String(design.location)) ? [] : [`${surface} 디자인을 열어 볼 주소(location)가 없습니다.`];
  }
  const file = join(root, htmlPath(id));
  if (!existsSync(file)) return [`${htmlPath(id)} 파일이 없습니다.`];
  return /^\s*<(!doctype html|html)/i.test(readFileSync(file, 'utf8')) ? [] : [`${htmlPath(id)}이(가) HTML 문서가 아닙니다.`];
};

const squash = (v: unknown) => String(v).replace(/[\s.]/g, '');

/** 지적마다 명문화한 규칙이 있는지, 규칙이 제대로 된 규칙인지 검사한다. */
const codifiedErrors = (codified: readonly Record<string, unknown>[], feedback: readonly string[]): string[] => [
  ...codified.flatMap((c, i) => [
    ...((ASPECTS as readonly unknown[]).includes(c.aspect) ? [] : [`명문화 ${i + 1}번의 aspect는 ${ASPECTS.join(' 또는 ')}여야 합니다.`]),
    ...(filled(c.source) ? [] : [`명문화 ${i + 1}번의 source(지적 원문)가 비어 있습니다.`]),
    ...(filled(c.rule) ? [] : [`명문화 ${i + 1}번의 rule이 비어 있습니다.`]),
    ...(c.scope === 'design' || c.scope === 'language' ? [] : [`명문화 ${i + 1}번의 scope는 design 또는 language여야 합니다.`]),
    ...(filled(c.rule) && squash(c.rule) === squash(c.source) ? [`명문화 ${i + 1}번은 지적 원문을 되풀이했습니다. 검사할 수 있는 규칙으로 바꿔 적어야 합니다.`] : []),
  ]),
  ...feedback
    .filter(f => !codified.some(c => squash(c.source) === squash(f)))
    .map(f => `지적 "${f}"을(를) 명문화한 규칙이 없습니다.`),
];

/** 디자인 에이전트 출력을 코드로 검사한다. 어느 도구로 그렸든 같은 기준이다. */
export const checkDesignOutput = (
  output: unknown,
  { spec, surface, root, feedback }: Readonly<{ spec: SavedSpec; surface: Surface; root: string; feedback: readonly string[] }>,
): DesignCheck => {
  if (!isObject(output)) return { ok: false, errors: ['출력 형식이 객체가 아닙니다.'] };
  const questions = Array.isArray(output.questions) ? output.questions.filter(filled) : [];
  if (output.status === 'question') {
    return questions.length ? { ok: true, kind: 'question', questions } : { ok: false, errors: ['질문(question)인데 질문이 없습니다.'] };
  }
  if (output.status !== 'done') return { ok: false, errors: ['status는 done 또는 question이어야 합니다.'] };
  const design = output.design;
  if (!isObject(design)) return { ok: false, errors: ['완료(done)에는 design이 필요합니다.'] };

  const screens = Array.isArray(design.screens) ? design.screens.filter(isObject) : [];
  const codified = Array.isArray(design.codified) ? design.codified.filter(isObject) : [];
  const known = new Set(spec.acceptance.map(a => a.id));
  const cited = screens.flatMap(s => (Array.isArray(s.covers) ? s.covers.map(String) : []));
  const errors = [
    ...(questions.length ? ['완료(done)인데 질문이 남아 있습니다.'] : []),
    ...(filled(design.summary) ? [] : ['design.summary가 비어 있습니다.']),
    ...(screens.length ? [] : ['화면이 하나 이상 필요합니다.']),
    ...screens.flatMap((s, i) =>
      (['name', 'description'] as const).filter(k => !filled(s[k])).map(k => `화면 ${i + 1}번의 ${k}이(가) 비어 있습니다.`)),
    ...[...new Set(cited)].filter(id => !known.has(id)).map(id => `스펙에 없는 인수 조건 ${id}을(를) 다뤘다고 했습니다.`),
    ...locationErrors(design, surface, root, spec.id),
    ...codifiedErrors(codified, feedback),
  ];
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    kind: 'done',
    design: {
      summary: design.summary as string,
      location: surface === 'html' ? htmlPath(spec.id) : (design.location as string),
      screens: screens as unknown as Screen[],
      codified: codified as unknown as Codified[],
    },
  };
};

export const writeDesign = (root: string, id: string, design: SavedDesign) => {
  const dir = designDir(root, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'design.json');
  writeFileSync(`${file}.tmp`, JSON.stringify(design, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
};

export const readDesign = (root: string, id: string): SavedDesign | null => {
  const file = join(designDir(root, id), 'design.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as SavedDesign) : null;
};

/** 디자인 폴더 전체의 지문. 디자인 승인과 Design Gate가 이 값에 묶인다. */
export const designHash = (root: string, id: string): string | null => dirHash(designDir(root, id));

/** 사람이 승인 전에 읽을 요약 */
export const renderDesign = (design: SavedDesign): string =>
  [
    `## 디자인 (${design.surface})\n\n${design.summary}\n\n보기: ${design.location}`,
    `### 화면\n\n${design.screens
      .map(s => `- **${s.name}**: ${s.description}${s.covers.length ? ` (다루는 인수 조건: ${s.covers.join(', ')})` : ''}`)
      .join('\n')}`,
    (design.codified ?? []).length
      ? `### 지적을 명문화한 규칙\n\n${design.codified
          .map(c => `- [${c.aspect.toUpperCase()}] "${c.source}" → ${c.rule} (${c.scope === 'language' ? '승인되면 디자인 언어에 추가' : '이 디자인에만 적용'})`)
          .join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');

/** 디자인 언어: 사람이 관리하는 두 문서. 두 검토 관점의 기준점이다. */
export const languageFile = (aspect: Aspect) => `design/${aspect}.md`;
export type DesignLanguage = Readonly<Record<Aspect, string | null>>;

export const readDesignLanguage = (root: string): DesignLanguage =>
  Object.fromEntries(
    ASPECTS.map(aspect => {
      const file = join(root, languageFile(aspect));
      const body = existsSync(file) ? readFileSync(file, 'utf8') : '';
      // 제목 줄만 있는 문서는 아무것도 정하지 않은 것이다.
      const hasRules = body.split('\n').some(line => line.trim() !== '' && !line.trim().startsWith('#'));
      return [aspect, hasRules ? body : null];
    }),
  ) as DesignLanguage;

/** 정해지지 않은 디자인 언어 문서의 경로 */
export const missingLanguage = (language: DesignLanguage): string[] =>
  ASPECTS.filter(aspect => language[aspect] === null).map(languageFile);

const RULES_HEADING = '## 검토에서 정해진 규칙';

/** 승인된 디자인의 일반 규칙을 관점에 맞는 디자인 언어 문서에 쌓는다. 쌓은 개수를 돌려준다. */
export const appendLanguageRules = (root: string, id: string, codified: readonly Codified[]): number =>
  codified.filter(c => c.scope === 'language').filter(c => {
    const file = join(root, languageFile(c.aspect));
    const body = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (body.includes(c.rule)) return false;
    mkdirSync(join(root, 'design'), { recursive: true });
    const heading = body.includes(RULES_HEADING) ? '' : `${body.endsWith('\n') || body === '' ? '' : '\n'}\n${RULES_HEADING}\n\n`;
    appendFileSync(file, `${heading}- ${c.rule} (출처: ${id}, 원문: "${c.source}")\n`);
    return true;
  }).length;
