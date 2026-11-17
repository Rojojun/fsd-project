import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCost, formatUsd } from '../src/cost.ts';
import type { RunRecord } from '../src/cost.ts';

const run = (over: Partial<Omit<RunRecord, 'usage'>> & { usage?: Partial<RunRecord['usage']> } = {}): RunRecord => ({
  at: '2026-11-17T00:00:00Z', node: 'spec', id: 'A', agent: 'claude', model: 'claude-opus-5-5', outcome: 'drafted',
  ...over,
  usage: { costUsd: 0.5, inputTokens: 1000, outputTokens: 100, turns: 2, durationMs: 1000, ...over.usage },
});

test('전체 합계: 비용, 토큰, 호출 수', () => {
  const s = summarizeCost([run(), run({ usage: { costUsd: 0.25 } })], {});
  assert.equal(s.total.calls, 2);
  assert.equal(s.total.costUsd, 0.75);
  assert.equal(s.total.inputTokens, 2000);
  assert.equal(s.total.unpriced, 0);
});

test('요구사항별, 노드별, 에이전트·모델별로 나눈다. 요구사항이 없는 호출은 공통으로 모은다', () => {
  const s = summarizeCost([
    run({ id: 'A', node: 'spec' }),
    run({ id: 'B', node: 'dev-backend', usage: { costUsd: 1 } }),
    run({ id: 'B', node: 'dev-frontend', usage: { costUsd: 2 } }),
    run({ id: null, node: 'audit', usage: { costUsd: 0.1 } }),
  ], {});
  assert.deepEqual(s.byRequirement.map(r => [r.key, r.costUsd]), [['B', 3], ['A', 0.5], ['(공통)', 0.1]]);
  assert.deepEqual(s.byNode.map(r => r.key), ['dev-frontend', 'dev-backend', 'spec', 'audit']);
  assert.deepEqual(s.byAgent.map(r => r.key), ['claude · claude-opus-5-5']);
});

test('비용을 알려 주지 않는 에이전트(codex)는 토큰만 더하고 "가격 미설정"으로 센다', () => {
  const s = summarizeCost([run(), run({ agent: 'codex', model: null, usage: { costUsd: null, inputTokens: 400_000, outputTokens: 10_000 } })], {});
  assert.equal(s.total.costUsd, 0.5);
  assert.equal(s.total.unpriced, 1);
  assert.equal(s.total.inputTokens, 401_000);
  assert.equal(s.byAgent.find(r => r.key === 'codex')?.unpriced, 1);
});

test('설정의 단가가 있으면 토큰으로 비용을 어림하고, 어림값임을 표시한다', () => {
  const prices = { codex: { inputPer1M: 1.25, outputPer1M: 10 } };
  const s = summarizeCost([run({ agent: 'codex', model: null, usage: { costUsd: null, inputTokens: 400_000, outputTokens: 10_000 } })], prices);
  assert.equal(s.total.costUsd, 0.6);
  assert.equal(s.total.estimated, 1);
  assert.equal(s.total.unpriced, 0);
});

test('단가는 모델 이름이 에이전트 이름보다 우선한다', () => {
  const prices = { codex: { inputPer1M: 1, outputPer1M: 0 }, 'gpt-x': { inputPer1M: 2, outputPer1M: 0 } };
  const s = summarizeCost([run({ agent: 'codex', model: 'gpt-x', usage: { costUsd: null, inputTokens: 1_000_000, outputTokens: 0 } })], prices);
  assert.equal(s.total.costUsd, 2);
});

test('에이전트가 알려 준 비용이 있으면 단가로 다시 계산하지 않는다', () => {
  const s = summarizeCost([run({ usage: { costUsd: 0.5 } })], { claude: { inputPer1M: 100, outputPer1M: 100 } });
  assert.equal(s.total.costUsd, 0.5);
  assert.equal(s.total.estimated, 0);
});

test('금액 표시: 소수 둘째 자리, 어림값과 가격 미설정을 붙인다', () => {
  assert.equal(formatUsd({ costUsd: 4.1523, estimated: 0, unpriced: 0 }), '$4.15');
  assert.equal(formatUsd({ costUsd: 1, estimated: 2, unpriced: 0 }), '≈$1.00');
  assert.equal(formatUsd({ costUsd: 1, estimated: 0, unpriced: 3 }), '$1.00 + 가격 미설정 3회');
  assert.equal(formatUsd({ costUsd: 0, estimated: 0, unpriced: 2 }), '가격 미설정 2회');
  assert.equal(formatUsd({ costUsd: 0, estimated: 0, unpriced: 0 }), '-');
});
