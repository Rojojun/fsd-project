import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PRIORITIES } from './model.ts';
import type { Priority, RequirementDoc } from './model.ts';

export type ParseResult = { ok: true; doc: RequirementDoc } | { ok: false; errors: string[] };

export const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * 마크다운 이스케이프 표기를 지운 본문. Linear가 같은 글을 `\[1\]`로도 `\\[1\\]`로도 내보내므로,
 * 표기만 다른 두 본문이 같은 내용으로 보이게 한다. 백슬래시가 없는 본문은 그대로다.
 */
export const unescapeMarkdown = (body: string) => body.replace(/\\+([\\`*_{}[\]()#+\-.!|>~])/g, '$1');

/** 선행 관계는 작업 순서에만 쓰이므로 내용 지문에서 뺀다. 이스케이프 표기 차이도 내용 변경으로 보지 않는다. */
const contentFingerprint = ({ depends: _depends, ...rest }: Record<string, unknown>, body: string) =>
  fingerprint(JSON.stringify({ front: rest, body: unescapeMarkdown(body) }));

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export const parseRequirement = (fileName: string, raw: string): ParseResult => {
  const text = raw.replaceAll('\r\n', '\n');
  const match = FRONT_MATTER.exec(text);
  if (!match) return { ok: false, errors: [`${fileName}: --- 로 감싼 YAML 머리말이 필요합니다.`] };

  const front = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
  const body = match[2].trim();
  const { id, title, priority, depends = [], policies = [], design = null, deprecated = false } = front;
  const expectedId = basename(fileName, '.md');

  const errors = [
    !nonEmpty(id) && 'id가 필요합니다.',
    nonEmpty(id) && id !== expectedId && `id(${id})와 파일 이름(${expectedId})이 같아야 합니다.`,
    !nonEmpty(title) && 'title이 필요합니다.',
    !PRIORITIES.includes(priority as Priority) && `priority는 ${PRIORITIES.join('/')} 중 하나여야 합니다.`,
    !isStringList(depends) && 'depends는 요구사항 ID 목록이어야 합니다.',
    isStringList(depends) && depends.includes(String(id)) && 'depends에 자기 자신을 넣을 수 없습니다.',
    !isStringList(policies) && 'policies는 정책 ID 목록이어야 합니다.',
    typeof deprecated !== 'boolean' && 'deprecated는 true/false여야 합니다.',
    design !== null && typeof design !== 'boolean' && 'design은 true/false여야 합니다.',
    body === '' && '요구사항 본문이 비어 있습니다.',
  ].filter((e): e is string => typeof e === 'string');

  if (errors.length) return { ok: false, errors: errors.map(e => `${fileName}: ${e}`) };
  return {
    ok: true,
    doc: {
      id: id as string,
      title: title as string,
      priority: priority as Priority,
      depends: depends as string[],
      policies: policies as string[],
      design: design as boolean | null,
      deprecated: deprecated as boolean,
      body,
      hash: fingerprint(text),
      contentHash: contentFingerprint(front, body),
    },
  };
};

export type Catalog = Readonly<{ docs: readonly RequirementDoc[]; errors: readonly string[] }>;

/** requirements/*.md 를 모두 읽는다. 잘못된 파일은 오류로 모으고 나머지는 계속 읽는다. */
export const loadCatalog = (dir: string): Catalog => {
  const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  const results = files.map(f => parseRequirement(f, readFileSync(join(dir, f), 'utf8')));
  const docs = results.flatMap(r => (r.ok ? [r.doc] : []));
  const ids = new Set(docs.map(d => d.id));
  const missingDeps = docs.flatMap(d =>
    d.depends.filter(dep => !ids.has(dep)).map(dep => `${d.id}.md: 선행 요구사항 ${dep}이(가) 없습니다.`),
  );
  return { docs, errors: [...results.flatMap(r => (r.ok ? [] : r.errors)), ...missingDeps] };
};
