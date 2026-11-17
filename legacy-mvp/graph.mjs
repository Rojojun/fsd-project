import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const [command = 'status', answer] = process.argv.slice(2);
const workspace = resolve(process.env.AGDD_WORKSPACE || '.agdd');
const statePath = join(workspace, 'state.json');
const appPath = join(workspace, 'app.mjs');
const planUrl = new URL('./plan.json', import.meta.url);
const testUrl = new URL('./verify.mjs', import.meta.url);
const fingerprint = input => createHash('sha256').update(input).digest('hex');
const initial = () => ({ stage: 'Upstream', planHash: null, history: [] });

let state;
try {
  state = JSON.parse(readFileSync(statePath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  state = initial();
}

function save(next) {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(statePath + '.tmp', JSON.stringify(next, null, 2) + '\n');
  renameSync(statePath + '.tmp', statePath);
  state = next;
}

function transition(stage, message, fields = {}) {
  save({
    ...state,
    ...fields,
    stage,
    history: [...state.history, { from: state.stage, to: stage, message }],
  });
  console.log(message);
}

function updatePlan() {
  const raw = readFileSync(planUrl, 'utf8');
  const planHash = fingerprint(raw);
  if (state.planHash === planHash) return;
  const plan = JSON.parse(raw);
  if (plan.id !== 'TASK-01' || typeof plan.requirement !== 'string' ||
      !plan.requirement.trim() || ![null, 'asc', 'desc'].includes(plan.order) ||
      typeof plan.newestFirst !== 'boolean') {
    throw new Error('plan.json의 id, requirement, order, newestFirst를 확인하세요.');
  }
  transition('Spec-drive', 'Upstream → 변경된 기획서를 카탈로그에 반영', {
    planHash, catalog: plan, spec: null, openQuestion: null,
    decision: null, approvedRevision: null, implementedRevision: null, bug: null, attempts: 0,
  });
}

function specRevision(spec) {
  return fingerprint(JSON.stringify(spec));
}

function run() {
  updatePlan();
  while (true) {
    switch (state.stage) {
      case 'Spec-drive': {
        const order = state.decision || state.catalog.order;
        if (!order) {
          transition('Waiting for decision', '정렬 순서 결정이 필요합니다. node graph.mjs answer desc', {
            openQuestion: '생성일 오름차순(asc)과 내림차순(desc) 중 어떤 순서인가요?',
          });
          return;
        }
        const spec = {
          id: state.catalog.id,
          planHash: state.planHash,
          endpoint: 'GET /tasks',
          order,
          acceptance: ['200 JSON 배열', 'createdAt 기준 지정된 순서', '빈 결과는 []'],
        };
        transition('Waiting for approval', '스펙 작성 완료. status로 확인하고 approve로 승인하세요.', {
          spec, openQuestion: null,
        });
        return;
      }
      case 'Dev': {
        if (state.approvedRevision !== specRevision(state.spec)) {
          throw new Error('현재 스펙 버전의 승인이 필요합니다.');
        }
        const order = state.bug ? state.spec.order : 'asc';
        const source = `export function createHandler(tasks) {
  return async request => {
    if (request.method !== 'GET' || new URL(request.url).pathname !== '/tasks') {
      return new Response(null, { status: 404 });
    }
    const result = tasks.toSorted((a, b) =>
      ${order === 'desc' ? 'b.createdAt.localeCompare(a.createdAt)' : 'a.createdAt.localeCompare(b.createdAt)'});
    return Response.json(result);
  };
}
`;
        writeFileSync(appPath + '.tmp', source);
        renameSync(appPath + '.tmp', appPath);
        transition('Verify', 'Dev → 구현 파일을 저장하고 E2E 검증으로 이동', {
          implementedRevision: state.approvedRevision,
        });
        break;
      }
      case 'Verify': {
        if (state.implementedRevision !== state.approvedRevision) {
          throw new Error('스펙 승인 버전과 구현 버전이 다릅니다.');
        }
        const test = spawnSync(process.execPath, [fileURLToPath(testUrl), appPath, state.spec.order], {
          encoding: 'utf8', timeout: 10_000,
        });
        if (test.error) throw test.error;
        if (test.status !== 0) {
          const attempts = state.attempts + 1;
          transition(attempts >= 2 ? 'Blocked' : 'Dev', 'Verify → HTTP 핸들러 계약 테스트 실패. 버그를 기록했습니다.', {
            attempts, bug: { revision: state.implementedRevision, evidence: test.stderr.trim() },
          });
          break;
        }
        transition('Audit', 'Verify → HTTP 핸들러 계약 테스트 통과', { bug: null });
        break;
      }
      case 'Audit': {
        if (state.catalog.newestFirst && state.spec.order !== 'desc') {
          transition('Waiting for decision', 'Audit → 최신순 정책과 스펙이 충돌합니다. node graph.mjs answer desc', {
            openQuestion: '최신순 정책과 일치하도록 정렬 순서를 내림차순으로 수정할까요?',
            approvedRevision: null, implementedRevision: null, attempts: 0,
          });
          return;
        }
        transition('Done', 'Audit → 정책과 스펙이 일치합니다. 완료.');
        return;
      }
      default:
        console.log('현재 상태: ' + state.stage);
        return;
    }
  }
}

switch (command) {
  case 'status':
    console.log(JSON.stringify(state, null, 2));
    break;
  case 'run':
    run();
    break;
  case 'answer':
    updatePlan();
    if (state.stage !== 'Waiting for decision' || !['asc', 'desc'].includes(answer)) {
      throw new Error('열린 질문이 있을 때 answer asc 또는 answer desc를 입력하세요.');
    }
    transition('Spec-drive', '사람의 답변을 기록했습니다.', {
      decision: answer, openQuestion: null, spec: null,
    });
    run();
    break;
  case 'approve':
    updatePlan();
    if (state.stage !== 'Waiting for approval') throw new Error('승인할 최신 스펙이 없습니다.');
    transition('Dev', '승인한 스펙 버전을 기록했습니다.', {
      approvedRevision: specRevision(state.spec),
    });
    run();
    break;
  default:
    throw new Error('명령: status | run | answer asc | answer desc | approve');
}
