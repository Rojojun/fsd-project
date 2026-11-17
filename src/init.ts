import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LinearFilter, LinearScopes } from './sources/linear.ts';

/**
 * 처음 한 번 묻는다: 요구사항을 Linear에서 가져올 것인가.
 * Linear가 연결되어 있다고 해서 저절로 쓰지 않는다. 요구사항의 원본을 어디에 둘지는 사람이 정한다.
 * 답은 agdd.config.json에 남고, 다시 묻지 않는다. 바꾸려면 agdd init을 다시 실행한다.
 */

export type Discover = () => Promise<{ ok: true; scopes: LinearScopes } | { ok: false; message: string }>;

export type InitInput = Readonly<{
  root: string;
  ask: (question: string) => Promise<string>;
  /** Linear를 살펴보고 범위의 후보를 돌려준다. 쓴다고 답했을 때만 부른다 */
  discover: Discover;
  log: (line: string) => void;
  /** 답을 미리 줄 때(명령의 옵션). 주어진 것은 묻지 않는다 */
  preset?: Readonly<{ useLinear?: boolean; project?: string; team?: string }>;
}>;

/** linear: 고른 범위, null이면 파일로 직접 쓴다. undefined면 정하지 못해 아무것도 바꾸지 않았다. */
export type InitResult = Readonly<{ linear?: LinearFilter | null }>;

/**
 * 기본 범위: 시작 전(Todo)과 진행 중인 이슈만.
 * 백로그는 아직 하기로 정하지 않은 일이라 스펙을 쓰지 않는다. 상태의 이름은 팀마다 달라서 종류로 고른다.
 */
export const READY_STATE_TYPES = ['unstarted', 'started'] as const;

const TRIES = 3;
/** 한 번에 보여 줄 후보의 수. 프로젝트와 팀 각각 */
const SHOW_PROJECTS = 10;
const SHOW_TEAMS = 2;
const yes = (answer: string) => /^(y|yes|ㅇ|예|네|응)$/i.test(answer.trim());

const save = (root: string, linear: LinearFilter | null) => {
  const file = join(root, 'agdd.config.json');
  const current = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  const source = { ...(current.source as Record<string, unknown> | undefined), linear };
  writeFileSync(file, JSON.stringify({ ...current, source }, null, 2) + '\n');
};

const withStates = (scope: { project: string } | { team: string }): LinearFilter => ({ ...scope, stateTypes: [...READY_STATE_TYPES] });

export const runInit = async ({ root, ask, discover, log, preset = {} }: InitInput): Promise<InitResult> => {
  const useLinear = preset.useLinear
    ?? yes(await ask('요구사항을 Linear에서 가져올까요? 가져오지 않으면 requirements/ 폴더에 파일로 직접 씁니다. (y/N) '));

  const files = (reason?: string): InitResult => {
    if (reason) log(reason);
    save(root, null);
    log('요구사항은 requirements/<ID>.md 파일로 직접 씁니다. 나중에 바꾸려면 agdd init을 다시 실행하세요.');
    return { linear: null };
  };
  const chosen = (linear: LinearFilter): InitResult => {
    save(root, linear);
    log(`Linear의 ${linear.project ? `프로젝트 "${linear.project}"` : `팀 "${linear.team}"`}에서, 시작 전이거나 진행 중인 이슈를 요구사항으로 가져옵니다.`);
    log('agdd pull --dry-run 으로 무엇이 들어오는지 먼저 확인하세요.');
    return { linear };
  };

  if (!useLinear) return files();
  if (preset.project) return chosen(withStates({ project: preset.project }));
  if (preset.team) return chosen(withStates({ team: preset.team }));

  const found = await discover();
  if (!found.ok) return files(found.message);

  // 진행할 이슈가 많은 것부터. 프로젝트 하나가 대상 프로젝트 하나에 해당하는 경우가 많아 프로젝트를 먼저 보여 준다.
  const byReady = <T extends { name: string; ready: number }>(a: T, b: T) => b.ready - a.ready || a.name.localeCompare(b.name);
  const total = found.scopes.projects.length + found.scopes.teams.length;
  if (total === 0) return files('Linear에서 프로젝트나 팀을 찾지 못했습니다.');
  // 가져올 이슈가 없는 범위는 골라도 아무것도 오지 않는다. 전부 그런 경우가 아니면 보여 주지 않는다.
  const anyReady = [...found.scopes.projects, ...found.scopes.teams].some(s => s.ready > 0);
  const worth = <T extends { ready: number }>(list: readonly T[]) => (anyReady ? list.filter(s => s.ready > 0) : [...list]);
  const candidates = [
    ...worth(found.scopes.projects).sort(byReady).slice(0, SHOW_PROJECTS).map(p => ({ label: `프로젝트  ${p.name}  (팀 ${p.team}, 진행할 이슈 ${p.ready}건)`, scope: { project: p.name } })),
    ...worth(found.scopes.teams).sort(byReady).slice(0, SHOW_TEAMS).map(t => ({ label: `팀 전체   ${t.name}  (진행할 이슈 ${t.ready}건)`, scope: { team: t.name } })),
  ];

  log('어느 범위의 이슈를 요구사항으로 쓸까요? 시작 전이거나 진행 중인 이슈만 가져옵니다(백로그는 가져오지 않습니다).');
  if (!anyReady) log('지금은 어느 범위에도 시작 전이거나 진행 중인 이슈가 없습니다. 범위를 골라 두면 이슈가 생겼을 때 가져옵니다.');
  candidates.forEach((c, i) => log(`  ${i + 1}) ${c.label}${i === 0 ? '  ← 추천' : ''}`));
  if (total > candidates.length) {
    log(`  그 밖에 ${total - candidates.length}개가 더 있습니다. 목록에 없는 것은 agdd init --linear --project "<이름>" (또는 --team)으로 직접 정합니다.`);
  }

  for (let attempt = 0; attempt < TRIES; attempt++) {
    const answer = (await ask(`번호를 고르세요 (Enter = 1): `)).trim();
    const picked = candidates[answer === '' ? 0 : Number(answer) - 1];
    if (picked && (answer === '' || /^\d+$/.test(answer))) return chosen(withStates(picked.scope));
    log(`1부터 ${candidates.length} 사이의 번호를 적어 주세요.`);
  }
  log('범위를 정하지 못했습니다. 설정은 바꾸지 않았습니다.');
  return {};
};
