import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 인계 메모. 매 실행은 새 세션이라 이전 실행이 알아낸 것(어디에 무엇을 두었는지, 무엇이 남았는지)을 모른다.
 * 에이전트가 끝날 때 남긴 메모를 다음 실행의 프롬프트에 넣어, 같은 탐색을 되풀이하지 않게 한다.
 */
const file = (root: string, id: string) => join(root, '.fsd', 'notes', `${id}.md`);

/** 프롬프트에 넣을 최대 길이. 넘치면 최근 것만 남긴다. */
const LIMIT = 6000;

export const appendNote = (root: string, id: string, at: string, author: string, text: string) => {
  if (!text.trim()) return;
  mkdirSync(join(root, '.fsd', 'notes'), { recursive: true });
  appendFileSync(file(root, id), `## ${at} ${author}\n\n${text.trim()}\n\n`);
};

export const readNotes = (root: string, id: string): string => {
  const path = file(root, id);
  if (!existsSync(path)) return '';
  const all = readFileSync(path, 'utf8');
  return all.length <= LIMIT ? all : all.slice(all.indexOf('\n## ', all.length - LIMIT) + 1);
};
