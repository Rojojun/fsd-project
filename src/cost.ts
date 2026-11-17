import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 비용 집계. 에이전트 호출마다 남긴 기록(.fsd/runs/)을 모아 어디에 얼마가 들었는지 보여 준다.
 * claude는 비용을 직접 알려 주고, codex는 토큰만 알려 준다. 단가를 설정에 적으면 토큰으로 어림한다.
 */

export type RunRecord = Readonly<{
  at: string;
  node: string;
  /** 요구사항 ID. 요구사항에 묶이지 않은 호출(init, pull, audit)은 null */
  id: string | null;
  agent: string;
  model: string | null;
  outcome: string;
  usage: Readonly<{
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    turns: number | null;
    durationMs: number;
  }>;
}>;

/** 100만 토큰당 달러. 키는 모델 이름 또는 에이전트 이름 (모델 이름이 우선) */
export type Prices = Readonly<Record<string, Readonly<{ inputPer1M: number; outputPer1M: number }>>>;

export type CostLine = Readonly<{
  key: string;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** 단가로 어림한 호출 수 */
  estimated: number;
  /** 비용도 단가도 없어 금액에 넣지 못한 호출 수 */
  unpriced: number;
}>;

export type CostSummary = Readonly<{
  total: CostLine;
  byRequirement: readonly CostLine[];
  byNode: readonly CostLine[];
  byAgent: readonly CostLine[];
}>;

const SHARED = '(공통)';

/** 한 호출의 금액과 그 금액이 어디서 왔는지 */
const priceOf = (run: RunRecord, prices: Prices): { costUsd: number; kind: 'reported' | 'estimated' | 'unpriced' } => {
  if (run.usage.costUsd !== null) return { costUsd: run.usage.costUsd, kind: 'reported' };
  const price = (run.model && prices[run.model]) || prices[run.agent];
  if (!price) return { costUsd: 0, kind: 'unpriced' };
  const cost = ((run.usage.inputTokens ?? 0) * price.inputPer1M + (run.usage.outputTokens ?? 0) * price.outputPer1M) / 1_000_000;
  return { costUsd: cost, kind: 'estimated' };
};

const line = (key: string, runs: readonly RunRecord[], prices: Prices): CostLine => {
  const priced = runs.map(r => priceOf(r, prices));
  return {
    key,
    calls: runs.length,
    costUsd: priced.reduce((sum, p) => sum + p.costUsd, 0),
    inputTokens: runs.reduce((sum, r) => sum + (r.usage.inputTokens ?? 0), 0),
    outputTokens: runs.reduce((sum, r) => sum + (r.usage.outputTokens ?? 0), 0),
    durationMs: runs.reduce((sum, r) => sum + r.usage.durationMs, 0),
    estimated: priced.filter(p => p.kind === 'estimated').length,
    unpriced: priced.filter(p => p.kind === 'unpriced').length,
  };
};

const groupBy = (runs: readonly RunRecord[], keyOf: (r: RunRecord) => string, prices: Prices): CostLine[] =>
  [...Map.groupBy(runs, keyOf)]
    .map(([key, group]) => line(key, group, prices))
    .sort((a, b) => b.costUsd - a.costUsd || b.unpriced - a.unpriced || a.key.localeCompare(b.key));

export const summarizeCost = (runs: readonly RunRecord[], prices: Prices): CostSummary => ({
  total: line('전체', runs, prices),
  byRequirement: groupBy(runs, r => r.id ?? SHARED, prices),
  byNode: groupBy(runs, r => r.node, prices),
  byAgent: groupBy(runs, r => (r.model ? `${r.agent} · ${r.model}` : r.agent), prices),
});

export const loadRuns = (dir: string): RunRecord[] =>
  existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunRecord)
    : [];

/** 금액 표시. 어림값이면 ≈, 금액에 넣지 못한 호출이 있으면 그 수를 붙인다. */
export const formatUsd = ({ costUsd, estimated, unpriced }: Pick<CostLine, 'costUsd' | 'estimated' | 'unpriced'>): string => {
  const amount = costUsd > 0 || unpriced === 0 ? `${estimated ? '≈' : ''}$${costUsd.toFixed(2)}` : '';
  if (costUsd === 0 && unpriced === 0) return '-';
  return [amount, unpriced ? `가격 미설정 ${unpriced}회` : ''].filter(Boolean).join(' + ');
};
