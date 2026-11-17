import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Limits } from './flags.ts';
import type { Config } from './select.ts';
import type { RequirementState } from './model.ts';

/** 저장소 안의 경로 규약. 모든 상태는 저장소 안에 있다(SSOT). */
export const paths = (root: string) => ({
  requirements: join(root, 'requirements'),
  state: join(root, '.agdd', 'state'),
  config: join(root, 'agdd.config.json'),
});

export type Settings = Config & Readonly<{ limits: Limits }>;

const DEFAULT_CONFIG: Settings = {
  wip: { spec: 3 },
  limits: { rejections: 3, reworks: 3, sameFailure: 2 },
};

export const loadConfig = (root: string): Settings => {
  const file = paths(root).config;
  if (!existsSync(file)) return DEFAULT_CONFIG;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { wip?: Partial<Settings['wip']>; limits?: Partial<Limits> };
  return { wip: { ...DEFAULT_CONFIG.wip, ...raw.wip }, limits: { ...DEFAULT_CONFIG.limits, ...raw.limits } };
};

export const loadStates = (root: string): RequirementState[] => {
  const dir = paths(root).state;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as RequirementState);
};

/** 임시 파일에 쓰고 rename 한다. 중간에 죽어도 상태 파일이 깨지지 않는다. */
export const saveState = (root: string, state: RequirementState) => {
  const dir = paths(root).state;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${state.id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
};
