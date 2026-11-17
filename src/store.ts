import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Limits } from './flags.ts';
import type { LinearFilter } from './sources/linear.ts';
import type { Config } from './select.ts';
import type { RequirementState } from './model.ts';

/** 저장소 안의 경로 규약. 모든 상태는 저장소 안에 있다(SSOT). */
export const paths = (root: string) => ({
  requirements: join(root, 'requirements'),
  policies: join(root, 'policies'),
  design: join(root, 'design'),
  skills: join(root, 'skills'),
  runs: join(root, '.agdd', 'runs'),
  state: join(root, '.agdd', 'state'),
  config: join(root, 'agdd.config.json'),
});

export type Role = 'spec-writer' | 'designer' | 'dev' | 'dev-backend' | 'dev-frontend' | 'qa' | 'linear-reader';
export type RoleSetting = Readonly<{ agent: string; model?: string }>;

export type Settings = Config & Readonly<{
  limits: Limits;
  /** 역할마다 어떤 에이전트(와 모델)를 쓸지 */
  roles: Readonly<Record<Role, RoleSetting>>;
  /** 에이전트 호출 한 번의 한도 */
  agent: Readonly<{ timeoutMs: number; maxTurns: number }>;
  /** 대상 프로젝트의 E2E 실행 명령. {id}는 요구사항 ID로 바뀐다. 정하지 않으면 verify를 돌릴 수 없다 */
  verify: Readonly<{ command: string | null; timeoutMs: number }>;
  /** 요구사항을 어디서 가져오는가. linear가 없으면 requirements/ 에 사람이 직접 쓴다 */
  source: Readonly<{ linear: LinearFilter | null }>;
}>;

const DEFAULT_CONFIG: Settings = {
  wip: { spec: 3, design: 3 },
  limits: { rejections: 3, reworks: 3, sameFailure: 2 },
  roles: {
    'spec-writer': { agent: 'claude' },
    designer: { agent: 'claude' },
    dev: { agent: 'claude' },
    'dev-backend': { agent: 'claude' },
    'dev-frontend': { agent: 'claude' },
    qa: { agent: 'claude' },
    'linear-reader': { agent: 'claude' },
  },
  agent: { timeoutMs: 600_000, maxTurns: 30 },
  verify: { command: null, timeoutMs: 600_000 },
  source: { linear: null },
};

export const loadConfig = (root: string): Settings => {
  const file = paths(root).config;
  if (!existsSync(file)) return DEFAULT_CONFIG;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { [K in keyof Settings]?: Partial<Settings[K]> };
  return {
    wip: { ...DEFAULT_CONFIG.wip, ...raw.wip },
    limits: { ...DEFAULT_CONFIG.limits, ...raw.limits },
    // 백엔드·프론트엔드 역할을 따로 정하지 않았으면 dev 역할의 설정을 따른다.
    roles: {
      ...DEFAULT_CONFIG.roles,
      ...(raw.roles?.dev ? { 'dev-backend': raw.roles.dev, 'dev-frontend': raw.roles.dev } : {}),
      ...raw.roles,
    } as Settings['roles'],
    agent: { ...DEFAULT_CONFIG.agent, ...raw.agent },
    verify: { ...DEFAULT_CONFIG.verify, ...raw.verify },
    source: { ...DEFAULT_CONFIG.source, ...raw.source } as Settings['source'],
  };
};

export const loadStates = (root: string): RequirementState[] => {
  const dir = paths(root).state;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    // 예전 형식의 상태 파일에는 나중에 생긴 항목이 없다. 기본값으로 채운다.
    .map(f => ({ designRequired: false, approvedDesignHash: null, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }) as RequirementState);
};

/** 임시 파일에 쓰고 rename 한다. 중간에 죽어도 상태 파일이 깨지지 않는다. */
export const saveState = (root: string, state: RequirementState) => {
  const dir = paths(root).state;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${state.id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
};

/** 에이전트 호출 기록. 무엇을 얼마에 돌렸는지 남긴다. 상태 판단에는 쓰지 않는다. */
export const saveRun = (root: string, at: string, record: Readonly<{ node: string; id: string | null; [key: string]: unknown }>) => {
  const dir = paths(root).runs;
  mkdirSync(dir, { recursive: true });
  const name = `${at.replace(/[:.]/g, '-')}-${record.node}-${record.id ?? 'none'}.json`;
  writeFileSync(join(dir, name), JSON.stringify({ at, ...record }, null, 2) + '\n');
};
