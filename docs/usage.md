# 사용 방법

fsd는 요구사항 하나하나를 스펙 → (디자인) → 구현 → 검증으로 옮기는 도구다.
사람은 요구사항을 쓰고, 질문에 답하고, 초안을 승인한다. 나머지는 노드가 한 사이클씩 진행한다.

왜 이렇게 생겼는지는 [why.md](why.md), 상태와 전이 규칙의 전체 표는 [graph.md](graph.md)에 있다.

## 1. 준비

- Node.js 24 이상.
- `claude`(Claude Code)와 `codex`(Codex CLI) 가운데 쓸 것이 설치되어 로그인되어 있어야 한다. 하나만 있어도 된다.
- fsd는 **대상 프로젝트의 폴더에서** 실행한다. 이 저장소의 예제는 `examples/meeting-report/`다.

```sh
npm install                      # 이 저장소에서 한 번
cd examples/meeting-report
npm install                      # 예제의 테스트 도구(Playwright)
node ../../src/cli.ts status     # 아래에서는 이 명령을 fsd라고 줄여 쓴다
```

처음 한 번 `fsd init`을 실행한다. 요구사항을 Linear에서 가져올지 묻고, 답을 `fsd.config.json`에 남긴다.
설정 파일이 없는 폴더에서 사람이 다른 명령을 먼저 실행해도 같은 것을 한 번 묻는다. 자동 실행에서는 묻지 않는다.

대상 프로젝트에는 다음이 있어야 한다.

| 파일 | 내용 |
|---|---|
| `AGENTS.md` | 프로젝트의 구조, 쓰는 도구, 서버를 띄우는 법, 테스트 쓰는 법. 구현과 QA 에이전트가 이것부터 읽는다. 여기에 없는 것은 에이전트가 질문한다. |
| `fsd.config.json` | E2E 실행 명령 등. 6장 참고. 없으면 기본값을 쓰지만 `verify.command`는 반드시 정해야 검증이 돈다. |
| `requirements/` | 요구사항. 직접 쓰거나 Linear에서 가져온다. |

## 2. 전체 흐름

```
요구사항 ──▶ spec ──▶ (design) ──▶ dev ──▶ verify ──▶ 끝
(파일/Linear)   │         │          │        │
              질문·승인  질문·승인    질문    실패하면 dev로
```

| 상태 | 뜻 | 다음에 움직이는 쪽 |
|---|---|---|
| `cataloged` | 요구사항이 등록됨 | spec 노드 |
| `specified` | 스펙 확정 | 디자인이 필요하면 design 노드, 아니면 dev 노드 |
| `designed` | 디자인 확정 | dev 노드 |
| `in-dev` | 구현 중 | dev 노드 |
| `implemented` | 구현 완료 | verify 노드 |
| `verified` | 검증 완료 | 없음 |
| `stale` | 요구사항이나 스펙이 바뀌어 다시 확정해야 함 | spec 노드 |
| `deprecated` | 폐기 | 없음 |

노드는 `fsd tick <노드>`로 한 사이클씩 돌린다. 한 사이클은 요구사항 하나를 한 걸음 옮기고 끝난다.
사람의 답이나 승인을 기다리는 요구사항은 노드가 건너뛴다.

## 3. 단계별

### 3.1 요구사항

**직접 쓸 때.** `requirements/<ID>.md`. 파일 이름과 `id`가 같아야 한다.

```markdown
---
id: TASK-01
title: 액션 아이템 목록 조회
priority: P0              # P0, P1, P2
depends: [AUTH-01]        # 선택. 먼저 스펙이 확정되어야 하는 요구사항
policies: [newest-first]  # 선택. 근거로 삼는 정책. policies/<이름>.md 가 있어야 한다
design: false             # 선택. 디자인 필요 여부를 못박는다. 없으면 spec 노드가 판단한다
---
무엇이 되어야 하는지 적는다. 형식은 자유다.
```

- 요구사항 사이의 순서는 `depends`로 사람이 정한다. AI가 순서를 추론하지 않는다.
- 폐기하려면 파일을 지우거나 `deprecated: true`를 적는다.
- 파일을 고치면 다음 명령에서 바로 반영된다. 스펙이 확정되기 전이면 초안을 버리고, 확정된 뒤면 `stale`이 된다.

**Linear에서 가져올 때.** Linear가 연결되어 있다고 저절로 쓰지 않는다. `fsd init`에서 쓴다고 답했을 때만 Linear가 원본이 된다.

```
$ fsd init
요구사항을 Linear에서 가져올까요? 가져오지 않으면 requirements/ 폴더에 파일로 직접 씁니다. (y/N) y
Linear를 살펴보는 중입니다…
어느 범위의 이슈를 요구사항으로 쓸까요? 시작 전이거나 진행 중인 이슈만 가져옵니다(백로그는 가져오지 않습니다).
  1) 프로젝트  회의 보고  (팀 제품, 진행할 이슈 7건)  ← 추천
  2) 프로젝트  사내 위키  (팀 플랫폼, 진행할 이슈 2건)
  3) 팀 전체   제품  (진행할 이슈 12건)
번호를 고르세요 (Enter = 1):
```

- 후보는 진행할 이슈가 많은 순이다. 가져올 이슈가 없는 범위는 보여 주지 않고, 프로젝트는 10개, 팀은 2개까지만 보여 준다.
  목록에 없는 것은 `fsd init --linear --project "<이름>"`(또는 `--team`)으로 정한다.
- 후보의 이슈 수는 에이전트가 Linear를 읽어 센 것이라 어림값이다. 고른 뒤 `fsd pull --dry-run`으로 실제로 무엇이 오는지 확인한다.
- **기본 범위.** 고른 프로젝트(또는 팀)에서 상태의 종류가 시작 전(`unstarted`)이거나 진행 중(`started`)인 이슈만 가져온다.
  백로그와 분류 전은 아직 하기로 정하지 않은 일이라 가져오지 않는다. 상태의 이름은 팀마다 달라서 종류로 고른다.
- 묻지 않고 정하려면 `fsd init --no-linear` 또는 `fsd init --linear --project "<이름>"`.
- 범위를 더 좁히려면 설정을 직접 고친다. `team`, `project`, `label`, `states`(상태의 이름), `stateTypes`(상태의 종류)를 쓸 수 있다.

```json
{ "source": { "linear": { "project": "회의 보고", "stateTypes": ["unstarted", "started"] } } }
```

```sh
fsd pull --dry-run     # 무엇이 바뀔지만 본다
fsd pull               # requirements/<이슈 식별자>.md 로 옮겨 적는다
```

| Linear | 요구사항 |
|---|---|
| 이슈 식별자 (`ENG-12`) | `id` |
| 제목, 설명 | `title`, 본문 (그대로 옮긴다) |
| 우선순위 긴급·높음 / 보통 / 낮음·없음 | `P0` / `P1` / `P2` |
| "blocked by" 관계 (함께 가져온 이슈만) | `depends` |
| 라벨 `policy:<이름>` | `policies` |
| 라벨 `design` / `no-design` | `design: true` / `false` |
| 취소된 이슈 | `deprecated: true` |

- 가져온 파일은 사본이다. 내용은 Linear에서 고치고 다시 `pull`한다. 파일을 직접 고치면 다음 `pull`에서 덮어쓴다.
- `pull`은 파일을 지우지 않는다. 이번에 오지 않은 이슈는 알려 주기만 한다.
- 같은 ID로 사람이 직접 쓴 파일이 있으면 덮어쓰지 않는다.
- Linear가 연결되어 있지 않으면 `pull`은 실패하고, 파일을 직접 쓰는 길을 안내한다.
- 질문에 답하거나 승인하는 일은 아직 Linear에서 할 수 없다. `fsd` 명령으로 한다.

### 3.2 스펙 (`fsd tick spec`)

우선순위가 높고 선행 요구사항의 스펙이 확정된 요구사항 하나를 골라, 계약과 인수 조건을 쓴다. 결과는 둘 중 하나다.

- **질문 대기**: 요구사항, 정책, 지난 결정 어디에도 근거가 없는 결정이 있다. `fsd show <ID>`로 읽고 답한다.
  ```sh
  fsd answer TASK-01 "1) a  2) 순서를 정하지 않는다  3) 항상 200"
  fsd tick spec
  ```
- **승인 대기**: 초안이 나왔다. `fsd show <ID>`로 읽고 승인하거나 반려한다.
  ```sh
  fsd approve TASK-01
  fsd reject TASK-01 "빈 목록일 때의 조건이 없다"    # 사유가 다음 초안에 반영된다
  ```

스펙에는 "디자인이 필요한가"와 그 이유도 적힌다. 스펙을 승인하면 이것도 함께 확정된다.

### 3.3 디자인 (`fsd tick design`) — 필요한 요구사항만

디자인이 필요 없는 요구사항은 이 단계를 건너뛴다. 필요한 요구사항이 있으면 먼저 **디자인 언어**를 써 둔다.

| 문서 | 정하는 것 |
|---|---|
| `design/ui.md` | 보이는 것: 색, 글꼴, 간격, 컴포넌트, 문구의 어조 |
| `design/ux.md` | 쓰는 흐름: 화면 전환, 상태(비어 있음, 오류), 피드백, 접근성 |

둘 중 하나라도 없으면 디자인 노드는 그리지 않고 요구사항을 spec 단계로 되돌린다.

그리는 곳은 실행할 때마다 연결된 도구를 보고 정한다: **Penpot → Figma → 둘 다 없으면 Claude가 HTML 파일로**(`designs/<ID>/index.html`).

검토는 두 관점에서 따로 한다.

```sh
fsd show UI-01                                   # 화면 설명과 위치
fsd approve UI-01 --ui                           # 보이는 것이 UI 기준에 맞는다
fsd approve UI-01 --ux                           # 쓰는 흐름이 UX 기준에 맞는다  → 둘 다 되면 designed
fsd reject UI-01 "줄이 답답해 보인다" --ui        # 느낌으로 적어도 된다
```

반려하면 디자인 노드가 지적을 검사할 수 있는 규칙으로 바꿔 적고("목록 줄의 위아래 여백은 20px 이상") 다시 그린다.
그 규칙 가운데 다른 화면에도 적용할 것은, 디자인이 승인될 때 `design/ui.md`나 `design/ux.md`에 쌓인다.

### 3.4 구현 (`fsd tick dev`)

- 디자인이 없으면 에이전트 하나가 구현한다.
- 디자인이 있으면 백엔드와 프론트엔드 에이전트가 동시에 구현한다.
- 끝나면 `implemented`. 질문이 있으면 질문 대기, 중간에 끊기면 `in-dev`에 머물고 다음 `tick dev`가 이어서 한다.
- 구현은 스펙, 디자인, E2E 테스트를 고칠 수 없다. 고치면 구현 완료로 넘어가지 않는다.

### 3.5 검증 (`fsd tick verify`)

1. QA 에이전트가 검사 계획(어느 인수 조건을, 어느 화면에서, 어떻게 검사하는지)을 세우고 E2E를 `e2e/<ID>/`에 쓴다.
2. 계획에 빠진 곳이 있으면 받아들이지 않는다(인수 조건마다, 디자인의 화면마다 검사가 있어야 한다).
3. 설정의 `verify.command`를 실행한다. 통과하면 `verified`, 실패하면 증거를 남기고 `in-dev`로 되돌린다.

실패했으면 `fsd tick dev`가 그 버그부터 고치고, 다시 `fsd tick verify`를 돌린다. 이때는 계획을 다시 쓰지 않고 테스트만 돌린다.
검사 계획은 `fsd show <ID>`로 본다.

## 4. 사람이 할 일

`fsd status`의 "대기 사유"에 무엇이든 있으면 사람 차례다.

| 보이는 것 | 뜻 | 할 일 |
|---|---|---|
| `질문 대기 Q3(spec)` | 노드가 결정을 묻는다 | `fsd show <ID>` → `fsd answer <ID> "<답>"` |
| `승인 대기 A5(spec)` | 스펙 초안 | `fsd show <ID>` → `approve` 또는 `reject "<사유>"` |
| `승인 대기 A7-ui(design)`, `A7-ux(design)` | 디자인 초안 | `approve --ui`, `approve --ux` 또는 `reject "<지적>" [--ui|--ux]` |

질문 대기에는 노드가 스스로 멈춘 경우도 있다.

- **반복 한도**: 같은 E2E 실패가 2번 연속되거나, 재작업이 3번, 초안 반려가 3번에 닿으면 더 시도하지 않고 묻는다. 답하면 횟수를 다시 센다.
- **E2E가 바뀜**: QA가 쓴 뒤 테스트 파일이 바뀌었다. 고친 테스트로 통과시키지 않고 묻는다.

스펙을 확정한 뒤에 잘못을 발견하면 다시 연다.

```sh
fsd respec TASK-01 "오류 응답을 정해야 한다"     # stale이 되고 spec 노드가 사유를 반영해 다시 쓴다
```

## 5. 지금 상태 보기

```sh
fsd status            # 표
fsd status --json     # 다른 도구나 에이전트가 읽을 것
fsd show <ID>         # 요구사항, 결정, 스펙, 디자인, 검사 계획, 버그
fsd next <노드>       # 그 노드가 다음에 고를 요구사항 (실행하지 않음)
```

"단계" 열은 상태 안에서 무엇을 기다리는지 보여 준다.

| 단계 | 뜻 |
|---|---|
| `ready` | 담당 노드가 집어 갈 수 있다 |
| `waiting-answer`, `waiting-approval` | 사람을 기다린다 |
| `blocked-by-dependency(TASK-01)` | 선행 요구사항의 스펙이 아직 확정되지 않았다 |
| `redraft(반려 1 · UI 반려)` | 초안이 반려되어 다시 써야 한다 |
| `building`, `rework(재작업 2)` | 처음 구현 중, E2E 실패로 고치는 중 |
| `done`, `closed` | 검증 완료, 폐기 |

## 6. 설정 (`fsd.config.json`)

적지 않은 것은 기본값을 쓴다.

```json
{
  "verify": { "command": "npx playwright test e2e/{id}/", "timeoutMs": 600000 },
  "roles": {
    "spec-writer": { "agent": "claude" },
    "designer":    { "agent": "claude" },
    "dev":         { "agent": "codex" },
    "qa":          { "agent": "claude", "model": "claude-sonnet-5-5" }
  },
  "agent":  { "timeoutMs": 900000, "maxTurns": 60 },
  "wip":    { "spec": 3, "design": 3 },
  "limits": { "rejections": 3, "reworks": 3, "sameFailure": 2 },
  "source": { "linear": { "project": "회의 보고" } }
}
```

| 항목 | 뜻 |
|---|---|
| `verify.command` | 대상 프로젝트의 E2E 실행 명령. `{id}`는 요구사항 ID로 바뀐다. 종료 코드 0이면 통과다. **기본값이 없다.** |
| `roles` | 역할마다 어느 에이전트(`claude`, `codex`)와 모델을 쓸지. `dev-backend`, `dev-frontend`를 따로 적지 않으면 `dev`를 따른다. 한 번만 바꾸려면 `fsd tick <노드> --agent codex`. |
| `agent` | 에이전트 호출 한 번의 시간과 턴 한도 |
| `wip` | 사람의 승인을 기다리는 초안이 이만큼 쌓이면 새 초안을 만들지 않는다 |
| `limits` | 반복 한도. 4장 참고 |
| `source.linear` | Linear에서 가져올 범위. `fsd init`이 쓴다. `null`이면 요구사항을 파일로 직접 쓴다 |

Linear를 읽는 역할(`linear-reader`)은 판단이 필요 없는 일이라 작은 모델이 기본이다. 큰 모델로는 살펴보기 한 번에 $1.6이 들었다.

에이전트에게 주는 규칙은 `skills/`의 문서다. 대상 프로젝트에 같은 이름의 `skills/<이름>.md`를 두면 그것을 대신 쓴다.

## 7. 계속 돌리기

지금은 `tick`을 사람이 실행한다. 노드는 할 일이 없으면 에이전트를 부르지 않고 바로 끝나므로, 주기적으로 실행해도 비용이 들지 않는다.

```sh
# 한 바퀴: 사람을 기다리는 것을 빼고 갈 수 있는 데까지
for node in spec design dev verify; do node ../../src/cli.ts tick $node; done
```

한 폴더에서 `tick`을 동시에 여러 개 돌리면 안 된다. 같은 요구사항을 두 번 집는 것을 막는 장치가 아직 없다.

## 8. 비용 참고

예제를 Claude(Fable 5.2)로 돌린 실측이다. 호출 한 번에 입력이 약 7만 토큰인데, 대부분은 에이전트 CLI의 기본 맥락이다.

| 호출 | 비용 | 시간 |
|---|---|---|
| 스펙 초안 또는 질문 | $0.2 ~ $0.5 | 15 ~ 30초 |
| 디자인 초안 (HTML) | $0.4 | 1분 안팎 |
| 구현 (API 하나) | $0.5 | 40초 |
| 검사 계획 + E2E 작성 | $0.7 ~ $1.0 | 70 ~ 90초 |
| Linear 가져오기 (작은 모델) | $0.01 | 15초 |
| Linear 살펴보기 (`fsd init`, 작은 모델) | $0.03 | 1분 반 |

호출마다 모델, 토큰, 비용이 `.fsd/runs/`에 남는다. 역할에 작은 모델을 지정하면 줄어든다.
