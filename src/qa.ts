import { join } from 'node:path';
import { dirHash } from './spec.ts';

/** 요구사항 하나의 E2E 테스트가 놓이는 자리. QA가 쓰고, dev는 고칠 수 없다. */
export const e2ePath = (id: string) => `e2e/${id}`;
export const e2eHash = (root: string, id: string): string | null => dirHash(join(root, e2ePath(id)));
