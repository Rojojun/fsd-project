#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeAgent } from './agents/claude.ts';
import { findServer, listServers } from './agents/mcp.ts';
import { runInit } from './init.ts';
import { discoverLinear, pullLinear } from './sources/linear.ts';
import { createInterface } from 'node:readline';
import { codexAgent } from './agents/codex.ts';
import type { Agent } from './agents/types.ts';
import { loadCatalog } from './catalog.ts';
import { appendLanguageRules, chooseSurface, designHash, missingLanguage, readDesign, readDesignLanguage, renderDesign } from './design.ts';
import { formatUsd, loadRuns, summarizeCost } from './cost.ts';
import type { CostLine, CostSummary } from './cost.ts';
import { escalate, flagsOf } from './flags.ts';
import type { Flags } from './flags.ts';
import { tickDesign } from './nodes/design.ts';
import { tickDev } from './nodes/dev.ts';
import { tickVerify } from './nodes/verify.ts';
import { readQaPlan, renderQaPlan } from './qa.ts';
import { tickSpec } from './nodes/spec.ts';
import type { TickResult } from './nodes/spec.ts';
import { pickNext } from './select.ts';
import type { PickNode } from './select.ts';
import { readSpec, renderSpec, specHash } from './spec.ts';
import { loadConfig, loadStates, paths, saveRun, saveState } from './store.ts';
import type { Settings } from './store.ts';
import { sync } from './sync.ts';
import { apply, TransitionError } from './transitions.ts';
import { ASPECTS } from './model.ts';
import type { Aspect, Hold, RequirementDoc, RequirementState } from './model.ts';

class UsageError extends Error {}

const USAGE = `사용법: fsd <명령>
  init [--linear [--project 이름|--team 이름]|--no-linear]
                             처음 한 번: 요구사항을 Linear에서 가져올지 정한다
  pull [--dry-run]           Linear의 이슈를 요구사항 파일로 가져온다 (init에서 Linear를 고른 경우)
  status [--json]            요구사항별 상태, 세부 단계, 대기 사유
  sync                       요구사항 파일 변경만 반영
  cost [--json]              에이전트 호출 비용: 전체, 요구사항별, 노드별, 에이전트별
  show <ID>                  요구사항 하나의 상태, 질문, 스펙 초안
  next <spec|design|dev|verify>  노드가 다음에 고를 후보 (실행하지 않음)
  tick <spec|design|dev|verify> [--agent 이름]  노드를 한 사이클 실행 (claude | codex)
  answer <ID> <답> [Q번호]   열린 질문에 답한다
  approve <ID> [--ui|--ux]   승인 대기 중인 초안(스펙 또는 디자인)을 확정한다. 디자인은 관점별로 승인할 수 있다
  reject <ID> <사유> [--ui|--ux]  승인 대기 중인 초안을 반려한다. 디자인은 어느 관점의 지적인지 밝힐 수 있다
  respec <ID> <사유>         확정된 스펙을 다시 연다`;

type Ctx = Readonly<{
  root: string;
  docs: readonly RequirementDoc[];
  states: readonly RequirementState[];
  at: string;
  /** --로 시작하는 인자 */
  flags: readonly string[];
}>;

/** --ui / --ux: 디자인 검토의 관점 */
const aspectOf = (flags: readonly string[]): { aspect?: Aspect } => {
  const aspect = ASPECTS.find(a => flags.includes(`--${a}`));
  return aspect ? { aspect } : {};
};

const holdLabel = (h: Hold) =>
  h.kind === 'question' ? `질문 대기 ${h.id}(${h.raisedBy}): ${h.message}` : `승인 대기 ${h.id}(${h.raisedBy})`;

/** 표에 쓰는 짧은 이름. 내용은 show에서 본다. */
const holdName = (h: Hold) => `${h.kind === 'question' ? '질문 대기' : '승인 대기'} ${h.id}(${h.raisedBy})`;

const table = (rows: string[][]) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  return rows.map(r => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
};

const REVIEW_LABEL = { none: '', pending: '대기', approved: '승인', rejected: '반려' } as const;

const phaseLabel = (f: Flags) => {
  const facts = [
    f.blockedBy.join(', '),
    f.rejections > 0 && `반려 ${f.rejections}`,
    f.reworks > 0 && `재작업 ${f.reworks}`,
    f.sameFailureStreak > 1 && `같은 실패 ${f.sameFailureStreak}`,
    f.staleReason,
    f.review && ASPECTS.filter(a => f.review![a] !== 'none').map(a => `${a.toUpperCase()} ${REVIEW_LABEL[f.review![a]]}`).join(' · '),
  ].filter(Boolean);
  return facts.length ? `${f.phase}(${facts.join(' · ')})` : f.phase;
};

const costOf = (ctx: Ctx): CostSummary => summarizeCost(loadRuns(paths(ctx.root).runs), loadConfig(ctx.root).prices);

const report = (ctx: Ctx) => {
  const { docs, states } = ctx;
  const docById = new Map(docs.map(d => [d.id, d]));
  const costById = new Map(costOf(ctx).byRequirement.map(c => [c.key, c]));
  return states.map(s => ({ state: s, doc: docById.get(s.id), flags: flagsOf(s, docById.get(s.id), states), cost: costById.get(s.id) ?? null }));
};

const NO_COST = { costUsd: 0, estimated: 0, unpriced: 0 };

const costRows = (lines: readonly CostLine[]) =>
  lines.map(c => [
    c.key, String(c.calls), formatUsd(c), c.inputTokens.toLocaleString('en-US'), c.outputTokens.toLocaleString('en-US'),
    `${Math.round(c.durationMs / 60_000)}분`,
  ]);

const costReport = (s: CostSummary) => {
  if (s.total.calls === 0) return '에이전트 호출 기록이 없습니다.';
  const head = (name: string) => [name, '호출', '비용', '입력 토큰', '출력 토큰', '시간'];
  return [
    table([head(''), ...costRows([s.total])]),
    `## 요구사항별\n${table([head('요구사항'), ...costRows(s.byRequirement)])}`,
    `## 노드별\n${table([head('노드'), ...costRows(s.byNode)])}`,
    `## 에이전트별\n${table([head('에이전트 · 모델'), ...costRows(s.byAgent)])}`,
    s.total.unpriced
      ? '가격 미설정: 비용을 알려 주지 않는 에이전트(codex)의 호출이다. fsd.config.json의 prices에 100만 토큰당 단가를 적으면 어림해서 더한다.'
      : '',
    s.total.estimated ? '≈ 표시는 설정의 단가로 토큰에서 어림한 금액이 섞였다는 뜻이다.' : '',
  ].filter(Boolean).join('\n\n');
};

const status = (ctx: Ctx) => {
  const rows = report(ctx).map(({ state: s, doc, flags, cost }) => [
    s.id,
    doc?.priority ?? '-',
    s.status,
    phaseLabel(flags),
    s.holds.map(holdName).join(' / ') || (s.bug && s.status === 'in-dev' ? `버그: ${s.bug.evidence.split('\n')[0].slice(0, 40)}` : ''),
    formatUsd(cost ?? NO_COST),
    doc?.title ?? '',
  ]);
  return table([['ID', '우선순위', '상태', '단계', '대기 사유', '비용', '제목'], ...rows]);
};

const statusJson = (ctx: Ctx) =>
  JSON.stringify(
    report(ctx).map(({ state: s, doc, flags, cost }) => ({
      id: s.id, title: doc?.title ?? null, priority: doc?.priority ?? null,
      status: s.status, flags, holds: s.holds, bug: s.bug, cost,
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
    // 지금 디스크에 있는 초안을 승인한다. 초안 제출 뒤 파일이 바뀌었으면 해시가 달라 거부된다.
    const s = find(ctx, id);
    if (s.holds.some(h => h.kind === 'approval' && h.raisedBy === 'design')) {
      return apply(s, 'approveDesign', 'human', { designHash: designHash(ctx.root, s.id) ?? '', ...aspectOf(ctx.flags) }, ctx.at);
    }
    // 디자인 필요 여부: 사람이 요구사항 머리말에 못박았으면 그 값, 아니면 spec 노드의 판단.
    const needsDesign = ctx.docs.find(d => d.id === s.id)?.design ?? readSpec(ctx.root, s.id)?.design?.needed ?? false;
    return apply(s, 'approveSpec', 'human', { specHash: specHash(ctx.root, s.id) ?? '', needsDesign }, ctx.at);
  },
  reject: (ctx, [id, reason]) => apply(find(ctx, id), 'reject', 'human', { reason: need(reason, '사유'), ...aspectOf(ctx.flags) }, ctx.at),
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
  const design = readDesign(ctx.root, s.id);
  const dHash = designHash(ctx.root, s.id);
  const designTitle = dHash && dHash === s.approvedDesignHash ? '확정 디자인' : '디자인 초안 (미승인)';
  const qaPlan = readQaPlan(ctx.root, s.id);
  return [
    `# ${s.id} ${doc?.title ?? ''}`,
    `상태: ${s.status} · ${phaseLabel(flagsOf(s, doc, ctx.states))}`,
    s.holds.map(h => `- ${holdLabel(h)}`).join('\n'),
    doc ? `## 요구사항\n\n${doc.body}` : '',
    s.decisions.length ? `## 내린 결정\n\n${s.decisions.map(d => `- ${d.question}\n  → ${d.answer}`).join('\n')}` : '',
    spec ? `---\n${specTitle}\n\n${renderSpec(spec)}` : '',
    design ? `---\n${designTitle}\n\n${renderDesign(design)}` : '',
    spec && qaPlan ? `---\n${renderQaPlan(qaPlan, spec, s.approvedDesignHash !== null ? design : null)}` : '',
    s.bug ? `---\n## 고쳐야 할 버그\n\n${s.bug.evidence}` : '',
  ].filter(Boolean).join('\n\n');
};

const agentFor = (name: string): Agent => {
  const make = AGENTS[name];
  if (!make) throw new UsageError(`모르는 에이전트: ${name} (가능: ${Object.keys(AGENTS).join(', ')})`);
  return make();
};

type Ticked = Readonly<{ result: TickResult; extra?: Record<string, unknown> }>;

const runSpec = async (ctx: Ctx, config: Settings, args: string[]): Promise<Ticked> => {
  const role = config.roles['spec-writer'];
  const policyIds = [...new Set(ctx.docs.flatMap(d => d.policies))];
  const result = await tickSpec({
    root: ctx.root, docs: ctx.docs, states: ctx.states, config, at: ctx.at,
    agent: agentFor(option(args, '--agent') ?? role.agent),
    settings: { ...config.agent, ...(role.model ? { model: role.model } : {}) },
    skill: loadSkill(ctx.root, 'spec-writer'),
    designLanguageReady: missingLanguage(readDesignLanguage(ctx.root)).length === 0,
    policies: Object.fromEntries(policyIds.map(id => [id, readFileSync(policyFile(ctx.root, id), 'utf8')])),
  });
  return { result };
};

const runDesign = async (ctx: Ctx, config: Settings, args: string[]): Promise<Ticked> => {
  // 디자인이 필요한 요구사항이 없으면 도구 확인도 에이전트 호출도 하지 않는다.
  const pick = pickNext('design', ctx.docs, ctx.states, config);
  if (pick.id === null) return { result: { id: null, outcome: 'idle', message: pick.reason } };

  // 디자인 언어가 없으면 노드가 spec으로 되돌린다. 그때는 도구 확인도 필요 없다.
  const language = readDesignLanguage(ctx.root);
  if (missingLanguage(language).length) {
    const result = await tickDesign({
      root: ctx.root, docs: ctx.docs, states: ctx.states, config, at: ctx.at, language,
      agent: () => { throw new Error('디자인 언어가 없을 때는 에이전트를 부르지 않는다'); },
      surface: 'html', server: null, settings: config.agent, skill: '', surfaceGuide: '',
    });
    return { result };
  }
  const role = config.roles.designer;
  const roleAgent = option(args, '--agent') ?? role.agent;
  agentFor(roleAgent);
  // 연결된 디자인 도구를 지금 확인해서 고른다: penpot → figma → 없으면 claude가 HTML로.
  const choice = await chooseSurface(roleAgent);
  const result = await tickDesign({
    root: ctx.root, docs: ctx.docs, states: ctx.states, config, at: ctx.at,
    agent: agentFor(choice.agent),
    surface: choice.surface,
    server: choice.server,
    settings: { ...config.agent, ...(role.model && choice.agent === role.agent ? { model: role.model } : {}) },
    skill: loadSkill(ctx.root, 'designer'),
    surfaceGuide: loadSkill(ctx.root, `design-${choice.surface}`),
    language,
  });
  return { result, extra: { surface: choice.surface } };
};

const runDev = async (ctx: Ctx, config: Settings, args: string[]): Promise<Ticked> => {
  const forced = option(args, '--agent');
  const roleOf = { full: config.roles.dev, backend: config.roles['dev-backend'], frontend: config.roles['dev-frontend'] } as const;
  const parts = ['full', 'backend', 'frontend'] as const;
  const result = await tickDev({
    root: ctx.root, docs: ctx.docs, states: ctx.states, config, at: ctx.at,
    agents: Object.fromEntries(parts.map(p => [p, agentFor(forced ?? roleOf[p].agent)])) as Record<(typeof parts)[number], Agent>,
    models: Object.fromEntries(parts.flatMap(p => (roleOf[p].model && !forced ? [[p, roleOf[p].model]] : []))),
    settings: config.agent,
    skill: loadSkill(ctx.root, 'dev'),
    partGuides: { backend: loadSkill(ctx.root, 'dev-backend'), frontend: loadSkill(ctx.root, 'dev-frontend') },
    language: readDesignLanguage(ctx.root),
  });
  return { result };
};

const runVerify = async (ctx: Ctx, config: Settings, args: string[]): Promise<Ticked> => {
  if (!config.verify.command) {
    throw new UsageError(
      'E2E 실행 명령이 정해져 있지 않습니다. fsd.config.json에 대상 프로젝트의 테스트 명령을 적어 주세요.\n'
      + '예: { "verify": { "command": "npm run e2e -- {id}" } }   ({id}는 요구사항 ID로 바뀝니다. 테스트는 e2e/<ID>/에 놓입니다.)',
    );
  }
  const role = config.roles.qa;
  const result = await tickVerify({
    root: ctx.root, docs: ctx.docs, states: ctx.states, config, at: ctx.at,
    agent: agentFor(option(args, '--agent') ?? role.agent),
    settings: { ...config.agent, ...(role.model ? { model: role.model } : {}) },
    skill: loadSkill(ctx.root, 'qa'),
    language: readDesignLanguage(ctx.root),
    command: config.verify.command,
    commandTimeoutMs: config.verify.timeoutMs,
  });
  return { result };
};

const TICKS: Readonly<Record<string, (ctx: Ctx, config: Settings, args: string[]) => Promise<Ticked>>> = {
  spec: runSpec,
  design: runDesign,
  dev: runDev,
  verify: runVerify,
};

const tick = async (ctx: Ctx, config: Settings, args: string[]) => {
  const node = args[0];
  const runNode = TICKS[node];
  if (!runNode) throw new UsageError(`tick은 ${Object.keys(TICKS).join(', ')}만 됩니다.\n\n${USAGE}`);
  const { result, extra } = await runNode(ctx, config, args);

  // 에이전트 호출마다 기록을 남긴다. 나눠 실행한 사이클은 부분마다 하나씩.
  const calls = result.runs ?? (result.run ? [{ part: 'full', run: result.run }] : []);
  calls.forEach(({ part, run }) => {
    const { agent, model, usage } = run;
    saveRun(ctx.root, ctx.at, { node: part === 'full' ? node : `${node}-${part}`, id: result.id, agent, model, outcome: result.outcome, usage, ...extra });
  });
  if (result.state) saveState(ctx.root, result.state);

  switch (result.outcome) {
    case 'idle': return console.log(result.message);
    case 'question': return console.log(`${node} → ${result.id} 질문 대기\n${result.message}\n\n답하기: fsd answer ${result.id} "<답>"`);
    case 'implemented': return console.log(`${node} → ${result.id} 구현 완료\n${result.message}`);
    case 'verified': return console.log(`${node} → ${result.id} 검증 완료\n${result.message}`);
    case 'failed': return console.log(`${node} → ${result.id} E2E 실패 → dev로 되돌림\n${result.message}`);
    case 'returned': return console.log(`${node} → ${result.id} 이전 단계로 되돌림\n${result.message}`);
    case 'drafted': return console.log(`${node} → ${result.id} 승인 대기\n${result.message}\n\n읽기: fsd show ${result.id}   승인: fsd approve ${result.id}`);
    default: throw new UsageError(`${node} → ${result.id}: ${result.message}`);
  }
};

/** 요구사항의 원본이 Linear일 때: 이슈를 requirements/ 로 옮겨 적는다. 그 뒤는 파일을 직접 쓴 것과 같다. */
const pull = async (root: string, at: string, args: string[]) => {
  const config = loadConfig(root);
  const filter = config.source.linear;
  if (!filter || Object.keys(filter).length === 0) {
    throw new UsageError(
      '요구사항을 Linear에서 가져오도록 정해져 있지 않습니다(source.linear가 없음).\n'
      + 'fsd init 을 실행하면 Linear를 쓸지 묻고, 쓴다면 가져올 범위를 고르게 합니다.\n'
      + 'Linear를 쓰지 않으면 requirements/<ID>.md를 직접 씁니다.',
    );
  }
  const role = config.roles['linear-reader'];
  const found = findServer(await listServers(role.agent), 'linear');
  if (!found) {
    throw new UsageError('Linear MCP 서버가 연결되어 있지 않습니다(인증이 안 된 서버는 연결된 것으로 치지 않습니다).\nLinear를 연결하거나, requirements/<ID>.md를 직접 써 주세요.');
  }
  const dryRun = args.includes('--dry-run');
  const result = await pullLinear({
    root, filter, dryRun, server: found.server,
    agent: agentFor(found.agent),
    settings: { ...config.agent, ...(role.model && found.agent === role.agent ? { model: role.model } : {}) },
    skill: loadSkill(root, 'linear-reader'),
  });
  if (result.run) {
    const { agent, model, usage } = result.run;
    saveRun(root, at, { node: 'pull', id: null, agent, model, outcome: result.ok ? 'pulled' : 'failed', usage });
  }
  if (!result.ok) throw new UsageError(result.message);

  const line = (label: string, ids: readonly string[]) => (ids.length ? `${label}: ${ids.join(', ')}` : '');
  console.log([
    dryRun ? '(--dry-run: 파일을 쓰지 않았습니다)' : '',
    line('새로 가져옴', result.created),
    line('바뀜', result.changed),
    line('그대로', result.unchanged),
    ...result.skipped.map(s => `건너뜀 ${s.id}: ${s.reason}`),
    line('이번에 오지 않음(파일은 그대로 둠)', result.missing),
    result.created.length + result.changed.length + result.unchanged.length === 0 ? '범위에 해당하는 이슈가 없습니다.' : '',
  ].filter(Boolean).join('\n'));
};

/** 묻고 한 줄을 받는다. 입력이 끝났으면 빈 답으로 친다. */
const prompter = () => {
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  return async (question: string) => {
    process.stdout.write(question);
    const next = await lines.next();
    if (!process.stdin.isTTY) process.stdout.write('\n');
    return next.done ? '' : next.value;
  };
};

/** 처음 한 번 묻는다: 요구사항을 Linear에서 가져올 것인가. 쓴다고 할 때만 Linear를 살펴본다. */
const init = async (root: string, at: string, args: string[]) => {
  const config = loadConfig(root);
  const role = config.roles['linear-reader'];
  const discover = async () => {
    const found = findServer(await listServers(role.agent), 'linear');
    if (!found) {
      return { ok: false as const, message: 'Linear MCP 서버가 연결되어 있지 않습니다(인증이 안 된 서버는 연결된 것으로 치지 않습니다). Linear를 연결한 뒤 fsd init을 다시 실행하세요.' };
    }
    console.log('Linear를 살펴보는 중입니다…');
    const result = await discoverLinear({
      root, server: found.server, agent: agentFor(found.agent),
      settings: { ...config.agent, ...(role.model && found.agent === role.agent ? { model: role.model } : {}) },
      skill: loadSkill(root, 'linear-scout'),
    });
    const { agent, model, usage } = result.run;
    saveRun(root, at, { node: 'init', id: null, agent, model, outcome: result.ok ? 'discovered' : 'failed', usage });
    return result;
  };
  const useLinear = args.includes('--linear') ? true : args.includes('--no-linear') ? false : undefined;
  await runInit({
    root, discover, log: line => console.log(line), ask: prompter(),
    preset: { useLinear, project: option(args, '--project'), team: option(args, '--team') },
  });
  process.stdin.pause();
};

const main = async (argv: string[]) => {
  const [command = 'status', ...args] = argv;
  const root = resolve(process.env.FSD_ROOT ?? process.cwd());
  const at = new Date().toISOString();

  if (['help', '--help', '-h'].includes(command)) return console.log(USAGE);
  if (command === 'init') return init(root, at, args);
  // 설정이 아직 없고 사람이 직접 실행했으면, 먼저 한 번 묻는다. 자동 실행(터미널이 아님)에서는 묻지 않고 기본값으로 간다.
  if (!existsSync(paths(root).config) && process.stdin.isTTY && process.stdout.isTTY) await init(root, at, []);

  // pull은 요구사항 폴더가 아직 없어도 된다. 만드는 쪽이다.
  if (command === 'pull') return pull(root, at, args);

  if (!existsSync(paths(root).requirements)) {
    throw new UsageError(`requirements 폴더가 없습니다: ${paths(root).requirements}\n요구사항 파일(requirements/<ID>.md)을 먼저 만들거나, Linear를 쓴다면 fsd pull로 가져오세요.`);
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
  const ctx: Ctx = { root, docs: catalog.docs, states: escalated.states, at, flags: args.filter(a => a.startsWith('--')) };
  const positional = args.filter(a => !a.startsWith('--'));

  if (command === 'cost') return console.log(args.includes('--json') ? JSON.stringify(costOf(ctx), null, 2) : costReport(costOf(ctx)));
  if (command === 'status') return console.log(args.includes('--json') ? statusJson(ctx) : status(ctx));
  if (command === 'sync') return synced.changes.length || console.log('sync: 변경 없음');
  if (command === 'show') return console.log(show(ctx, positional[0]));
  if (command === 'tick') return tick(ctx, config, args);
  if (command === 'next') {
    const node = args[0];
    if (!['spec', 'design', 'dev', 'verify'].includes(node)) throw new UsageError(USAGE);
    const pick = pickNext(node as PickNode, ctx.docs, ctx.states, config);
    return console.log(pick.id ? `${node} → ${pick.id}` : pick.reason);
  }
  const human = humanCommands[command];
  if (!human) throw new UsageError(USAGE);
  const next = human(ctx, positional);
  saveState(root, next);
  console.log(`${next.id}: ${next.history.at(-1)!.message} → ${next.status}`);

  // 디자인이 확정되면, 검토에서 명문화된 일반 규칙을 디자인 언어 문서에 쌓는다. 다음 디자인부터 기준이 된다.
  if (next.history.at(-1)!.transition === 'approveDesign' && next.status === 'designed') {
    const added = appendLanguageRules(root, next.id, readDesign(root, next.id)?.codified ?? []);
    if (added) console.log(`디자인 언어에 규칙 ${added}개를 추가했습니다 (design/ui.md, design/ux.md).`);
  }
};

main(process.argv.slice(2)).catch((e: unknown) => {
  if (!(e instanceof UsageError || e instanceof TransitionError)) throw e;
  console.error(e.message);
  process.exitCode = 1;
});
