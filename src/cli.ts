#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCatalog } from './catalog.ts';
import { pickNext } from './select.ts';
import { loadConfig, loadStates, paths, saveState } from './store.ts';
import { sync } from './sync.ts';
import { apply, TransitionError } from './transitions.ts';
import type { Hold, RequirementDoc, RequirementState } from './model.ts';

class UsageError extends Error {}

const USAGE = `사용법: agdd <명령>
  status                     요구사항별 상태와 대기 사유
  sync                       요구사항 파일 변경만 반영
  next <spec|dev|verify>     노드가 다음에 고를 후보 (실행하지 않음)
  answer <ID> <답> [Q번호]   열린 질문에 답한다
  approve <ID>               승인 대기 중인 스펙을 확정한다
  reject <ID> <사유>         승인 대기 중인 스펙을 반려한다
  respec <ID> <사유>         확정된 스펙을 다시 연다`;

type Ctx = Readonly<{ root: string; docs: readonly RequirementDoc[]; states: readonly RequirementState[]; at: string }>;

const holdLabel = (h: Hold) =>
  h.kind === 'question' ? `질문 대기 ${h.id}(${h.raisedBy}): ${h.message}` : `승인 대기 ${h.id}(${h.raisedBy})`;

const table = (rows: string[][]) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  return rows.map(r => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
};

const status = ({ docs, states }: Ctx) => {
  const docById = new Map(docs.map(d => [d.id, d]));
  const rows = states.map(s => [
    s.id,
    docById.get(s.id)?.priority ?? '-',
    s.status,
    s.holds.map(holdLabel).join(' / ') || (s.bug ? `버그: ${s.bug.evidence.split('\n')[0]}` : ''),
    docById.get(s.id)?.title ?? '',
  ]);
  return table([['ID', '우선순위', '상태', '대기 사유', '제목'], ...rows]);
};

const find = (ctx: Ctx, id: string | undefined) => {
  const s = ctx.states.find(x => x.id === id);
  if (!s) throw new UsageError(`요구사항 ${id ?? '(ID 없음)'}을(를) 찾을 수 없습니다.`);
  return s;
};

const need = (value: string | undefined, name: string) => {
  if (!value) throw new UsageError(`${name}이(가) 필요합니다.\n\n${USAGE}`);
  return value;
};

/** 사람이 하는 전이. 바뀐 상태 하나를 돌려준다. */
const humanCommands: Record<string, (ctx: Ctx, args: string[]) => RequirementState> = {
  answer: (ctx, [id, answer, holdId]) =>
    apply(find(ctx, id), 'answer', 'human', { answer: need(answer, '답'), holdId }, ctx.at),
  approve: (ctx, [id]) => {
    const s = find(ctx, id);
    const approval = s.holds.find(h => h.kind === 'approval');
    return apply(s, 'approveSpec', 'human', { specHash: approval?.artifactHash ?? '' }, ctx.at);
  },
  reject: (ctx, [id, reason]) => apply(find(ctx, id), 'reject', 'human', { reason: need(reason, '사유') }, ctx.at),
  respec: (ctx, [id, reason]) => apply(find(ctx, id), 'respec', 'human', { reason: need(reason, '사유') }, ctx.at),
};

const main = (argv: string[]) => {
  const [command = 'status', ...args] = argv;
  const root = resolve(process.env.AGDD_ROOT ?? process.cwd());
  const at = new Date().toISOString();

  if (!existsSync(paths(root).requirements)) {
    throw new UsageError(`requirements 폴더가 없습니다: ${paths(root).requirements}\n요구사항 파일(requirements/<ID>.md)을 먼저 만드세요.`);
  }
  const catalog = loadCatalog(paths(root).requirements);
  if (catalog.errors.length) {
    throw new UsageError(`요구사항 파일 오류로 중단합니다. 상태는 바뀌지 않았습니다.\n${catalog.errors.join('\n')}`);
  }

  // 모든 명령 전에 sync: 사람이 쓴 요구사항 파일이 항상 먼저 반영된다.
  const synced = sync(catalog.docs, loadStates(root), at);
  synced.changes.forEach(c => saveState(root, synced.states.find(s => s.id === c.id)!));
  synced.changes.forEach(c => console.log(`sync: ${c.id} ${c.transition}`));
  const ctx: Ctx = { root, docs: catalog.docs, states: synced.states, at };

  if (command === 'status') return console.log(status(ctx));
  if (command === 'sync') return synced.changes.length || console.log('sync: 변경 없음');
  if (command === 'next') {
    const node = args[0];
    if (node !== 'spec' && node !== 'dev' && node !== 'verify') throw new UsageError(USAGE);
    const pick = pickNext(node, ctx.docs, ctx.states, loadConfig(root));
    return console.log(pick.id ? `${node} → ${pick.id}` : pick.reason);
  }
  const human = humanCommands[command];
  if (!human) throw new UsageError(USAGE);
  const next = human(ctx, args);
  saveState(root, next);
  console.log(`${next.id}: ${next.history.at(-1)!.message} → ${next.status}`);
};

try {
  main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof UsageError || e instanceof TransitionError)) throw e;
  console.error(e.message);
  process.exitCode = 1;
}
