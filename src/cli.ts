#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeAgent } from './agents/claude.ts';
import { codexAgent } from './agents/codex.ts';
import type { Agent } from './agents/types.ts';
import { loadCatalog } from './catalog.ts';
import { escalate, flagsOf } from './flags.ts';
import type { Flags } from './flags.ts';
import { tickSpec } from './nodes/spec.ts';
import { pickNext } from './select.ts';
import { readSpec, renderSpec, specHash } from './spec.ts';
import { loadConfig, loadStates, paths, saveRun, saveState } from './store.ts';
import type { Settings } from './store.ts';
import { sync } from './sync.ts';
import { apply, TransitionError } from './transitions.ts';
import type { Hold, RequirementDoc, RequirementState } from './model.ts';

class UsageError extends Error {}

const USAGE = `사용법: agdd <명령>
  status [--json]            요구사항별 상태, 세부 단계, 대기 사유
  sync                       요구사항 파일 변경만 반영
  show <ID>                  요구사항 하나의 상태, 질문, 스펙 초안
  next <spec|dev|verify>     노드가 다음에 고를 후보 (실행하지 않음)
  tick spec [--agent 이름]   spec 노드를 한 사이클 실행 (claude | codex)
  answer <ID> <답> [Q번호]   열린 질문에 답한다
  approve <ID>               승인 대기 중인 스펙을 확정한다
  reject <ID> <사유>         승인 대기 중인 스펙을 반려한다
  respec <ID> <사유>         확정된 스펙을 다시 연다`;

type Ctx = Readonly<{ root: string; docs: readonly RequirementDoc[]; states: readonly RequirementState[]; at: string }>;

const holdLabel = (h: Hold) =>
  h.kind === 'question' ? `질문 대기 ${h.id}(${h.raisedBy}): ${h.message}` : `승인 대기 ${h.id}(${h.raisedBy})`;

/** 표에 쓰는 짧은 이름. 내용은 show에서 본다. */
const holdName = (h: Hold) => `${h.kind === 'question' ? '질문 대기' : '승인 대기'} ${h.id}(${h.raisedBy})`;

const table = (rows: string[][]) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  return rows.map(r => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
};

const phaseLabel = (f: Flags) => {
  const facts = [
    f.blockedBy.join(', '),
    f.rejections > 0 && `반려 ${f.rejections}`,
    f.reworks > 0 && `재작업 ${f.reworks}`,
    f.sameFailureStreak > 1 && `같은 실패 ${f.sameFailureStreak}`,
    f.staleReason,
  ].filter(Boolean);
  return facts.length ? `${f.phase}(${facts.join(' · ')})` : f.phase;
};

const report = ({ docs, states }: Ctx) => {
  const docById = new Map(docs.map(d => [d.id, d]));
  return states.map(s => ({ state: s, doc: docById.get(s.id), flags: flagsOf(s, docById.get(s.id), states) }));
};

const status = (ctx: Ctx) => {
  const rows = report(ctx).map(({ state: s, doc, flags }) => [
    s.id,
    doc?.priority ?? '-',
    s.status,
    phaseLabel(flags),
    s.holds.map(holdName).join(' / ') || (s.bug ? `버그: ${s.bug.evidence.split('\n')[0].slice(0, 40)}` : ''),
    doc?.title ?? '',
  ]);
  return table([['ID', '우선순위', '상태', '단계', '대기 사유', '제목'], ...rows]);
};

const statusJson = (ctx: Ctx) =>
  JSON.stringify(
    report(ctx).map(({ state: s, doc, flags }) => ({
      id: s.id, title: doc?.title ?? null, priority: doc?.priority ?? null,
      status: s.status, flags, holds: s.holds, bug: s.bug,
    })),
    null,
    2,
  );

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
    // 지금 디스크에 있는 스펙을 승인한다. 초안 제출 뒤 파일이 바뀌었으면 해시가 달라 거부된다.
    const s = find(ctx, id);
    return apply(s, 'approveSpec', 'human', { specHash: specHash(ctx.root, s.id) ?? '' }, ctx.at);
  },
  reject: (ctx, [id, reason]) => apply(find(ctx, id), 'reject', 'human', { reason: need(reason, '사유') }, ctx.at),
  respec: (ctx, [id, reason]) => apply(find(ctx, id), 'respec', 'human', { reason: need(reason, '사유') }, ctx.at),
};

const AGENTS: Readonly<Record<string, () => Agent>> = { claude: claudeAgent, codex: codexAgent };

const option = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

/** 규칙 문서는 프로젝트의 skills/ 가 있으면 그것을, 없으면 도구에 딸린 기본값을 쓴다. */
const loadSkill = (root: string, name: string) => {
  const local = join(paths(root).skills, `${name}.md`);
  const file = existsSync(local) ? local : fileURLToPath(new URL(`../skills/${name}.md`, import.meta.url));
  return readFileSync(file, 'utf8');
};

const policyFile = (root: string, id: string) => join(paths(root).policies, `${id}.md`);

const show = (ctx: Ctx, id: string | undefined) => {
  const s = find(ctx, id);
  const doc = ctx.docs.find(d => d.id === s.id);
  const spec = readSpec(ctx.root, s.id);
  const hash = specHash(ctx.root, s.id);
  const specTitle = hash && hash === s.approvedSpecHash ? '확정 스펙' : '스펙 초안 (미승인)';
  return [
    `# ${s.id} ${doc?.title ?? ''}`,
    `상태: ${s.status} · ${phaseLabel(flagsOf(s, doc, ctx.states))}`,
    s.holds.map(h => `- ${holdLabel(h)}`).join('\n'),
    doc ? `## 요구사항\n\n${doc.body}` : '',
    s.decisions.length ? `## 내린 결정\n\n${s.decisions.map(d => `- ${d.question}\n  → ${d.answer}`).join('\n')}` : '',
    spec ? `---\n${specTitle}\n\n${renderSpec(spec)}` : '',
  ].filter(Boolean).join('\n\n');
};

const tick = async (ctx: Ctx, config: Settings, args: string[]) => {
  if (args[0] !== 'spec') throw new UsageError(`아직 tick은 spec만 됩니다.\n\n${USAGE}`);
  const role = config.roles['spec-writer'];
  const agentName = option(args, '--agent') ?? role.agent;
  const makeAgent = AGENTS[agentName];
  if (!makeAgent) throw new UsageError(`모르는 에이전트: ${agentName} (가능: ${Object.keys(AGENTS).join(', ')})`);

  const policyIds = [...new Set(ctx.docs.flatMap(d => d.policies))];
  const result = await tickSpec({
    root: ctx.root, docs: ctx.docs, states: ctx.states, config, at: ctx.at,
    agent: makeAgent(),
    settings: { ...config.agent, ...(role.model ? { model: role.model } : {}) },
    skill: loadSkill(ctx.root, 'spec-writer'),
    policies: Object.fromEntries(policyIds.map(id => [id, readFileSync(policyFile(ctx.root, id), 'utf8')])),
  });

  if (result.run) {
    const { agent, model, usage } = result.run;
    saveRun(ctx.root, ctx.at, { node: 'spec', id: result.id, agent, model, outcome: result.outcome, usage });
  }
  if (result.state) saveState(ctx.root, result.state);

  switch (result.outcome) {
    case 'idle': return console.log(result.message);
    case 'question': return console.log(`spec → ${result.id} 질문 대기\n${result.message}\n\n답하기: agdd answer ${result.id} "<답>"`);
    case 'drafted': return console.log(`spec → ${result.id} 승인 대기\n${result.message}\n\n읽기: agdd show ${result.id}   승인: agdd approve ${result.id}`);
    default: throw new UsageError(`spec → ${result.id}: ${result.message}`);
  }
};

const main = async (argv: string[]) => {
  const [command = 'status', ...args] = argv;
  const root = resolve(process.env.AGDD_ROOT ?? process.cwd());
  const at = new Date().toISOString();

  if (!existsSync(paths(root).requirements)) {
    throw new UsageError(`requirements 폴더가 없습니다: ${paths(root).requirements}\n요구사항 파일(requirements/<ID>.md)을 먼저 만드세요.`);
  }
  const catalog = loadCatalog(paths(root).requirements);
  const missingPolicies = catalog.docs.flatMap(d =>
    d.policies.filter(id => !existsSync(policyFile(root, id))).map(id => `${d.id}.md: 정책 파일 policies/${id}.md이(가) 없습니다.`),
  );
  const errors = [...catalog.errors, ...missingPolicies];
  if (errors.length) {
    throw new UsageError(`요구사항 파일 오류로 중단합니다. 상태는 바뀌지 않았습니다.\n${errors.join('\n')}`);
  }

  // 모든 명령 전에 sync: 사람이 쓴 요구사항 파일이 항상 먼저 반영된다.
  const config = loadConfig(root);
  const synced = sync(catalog.docs, loadStates(root), at);
  // 같은 일을 되풀이하는 요구사항은 노드가 더 시도하기 전에 사람에게 넘긴다.
  const escalated = escalate(synced.states, config.limits, at);
  const changed = new Set([...synced.changes, ...escalated.changes].map(c => c.id));
  escalated.states.filter(s => changed.has(s.id)).forEach(s => saveState(root, s));
  const log = args.includes('--json') ? console.error : console.log;
  synced.changes.forEach(c => log(`sync: ${c.id} ${c.transition}`));
  escalated.changes.forEach(c => log(`escalate: ${c.id} 반복 한도 → 질문 대기`));
  const ctx: Ctx = { root, docs: catalog.docs, states: escalated.states, at };

  if (command === 'status') return console.log(args.includes('--json') ? statusJson(ctx) : status(ctx));
  if (command === 'sync') return synced.changes.length || console.log('sync: 변경 없음');
  if (command === 'show') return console.log(show(ctx, args[0]));
  if (command === 'tick') return tick(ctx, config, args);
  if (command === 'next') {
    const node = args[0];
    if (node !== 'spec' && node !== 'dev' && node !== 'verify') throw new UsageError(USAGE);
    const pick = pickNext(node, ctx.docs, ctx.states, config);
    return console.log(pick.id ? `${node} → ${pick.id}` : pick.reason);
  }
  const human = humanCommands[command];
  if (!human) throw new UsageError(USAGE);
  const next = human(ctx, args);
  saveState(root, next);
  console.log(`${next.id}: ${next.history.at(-1)!.message} → ${next.status}`);
};

main(process.argv.slice(2)).catch((e: unknown) => {
  if (!(e instanceof UsageError || e instanceof TransitionError)) throw e;
  console.error(e.message);
  process.exitCode = 1;
});
