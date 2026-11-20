# proto-fsd

요구사항 하나하나를 **스펙 → (디자인) → 구현 → 검증**으로 옮기는 자율 개발 CLI다. 명령 이름은 `fsd`다.

사람은 요구사항을 쓰고, 질문에 답하고, 초안을 승인한다. 나머지는 노드가 저장소의 상태를 읽고 한 걸음씩 진행한다.
노드가 부르는 AI는 Claude와 Codex 가운데 역할마다 골라 쓴다.

```
요구사항 ──▶ spec ──▶ (design) ──▶ dev ──▶ verify ──▶ 끝
(파일/Linear)   │         │          │        │
              질문·승인  질문·승인    질문    실패하면 dev로
                ▲
                └──── audit: 확정 스펙끼리 어긋나면 지적 → 사람이 respec으로 다시 연다
```

[NAVER D2 발표 "자율 그래프 주도 개발"](https://d2.naver.com/helloworld/5976687)의 구조를 바탕으로 만들었다.

---

## 1. 설치

### 꼭 필요한 것

| 무엇 | 왜 | 확인 |
|---|---|---|
| Node.js 24 이상 | proto-fsd가 TypeScript를 빌드 없이 바로 실행한다 | `node --version` |
| git | 승인과 산출물의 이력을 커밋으로 남긴다 | `git --version` |
| AI CLI 하나 이상, 로그인된 상태 | 노드가 부르는 에이전트 | 아래 둘 중 하나 |
| ├ [Claude Code](https://docs.anthropic.com/claude-code) | 기본 에이전트. 디자인 도구가 없을 때 HTML로 그리는 것도 이것이 한다 | `claude --version` |
| └ [Codex CLI](https://github.com/openai/codex) | 역할에 따라 바꿔 쓸 수 있다 | `codex --version` |

```sh
git clone <이 저장소> proto-fsd
cd proto-fsd
npm install
npm install -g .        # fsd, proto-fsd 명령이 생긴다
fsd --help
```

전역으로 설치하지 않으려면 `node <이 저장소>/src/cli.ts`를 `fsd` 대신 쓰면 된다.

### 선택 (opt)

있으면 쓰고, 없으면 다른 길로 간다. 언제든 나중에 더할 수 있다.

| 무엇 | 있으면 | 없으면 | 넣는 법 |
|---|---|---|---|
| **Playwright** | 화면이 있는 요구사항을 실제 브라우저로 검증한다 | 화면 E2E를 돌릴 수 없다 (API만 있는 프로젝트는 필요 없다) | 대상 프로젝트에서 `npm i -D @playwright/test`. 브라우저는 설치된 Chrome을 쓰거나(`use: { channel: 'chrome' }`) `npx playwright install chromium` |
| **Linear MCP** | 요구사항의 원본을 Linear 이슈로 둘 수 있다 | `requirements/`에 파일로 직접 쓴다 | `claude mcp add --transport http linear https://mcp.linear.app/mcp` 뒤 Claude Code에서 `/mcp`로 로그인 |
| **Penpot MCP** | 디자인을 Penpot에 그린다 (1순위) | 다음 순위로 | Penpot의 MCP 안내대로 `claude mcp add`. 서버 이름에 `penpot`이 들어가야 알아본다 |
| **Figma MCP** | 디자인을 Figma에 그린다 (2순위) | Claude가 HTML 파일로 그린다 (3순위) | Figma의 MCP 안내대로 `claude mcp add`. 서버 이름에 `figma`가 들어가야 알아본다. 읽기만 되는 서버면 디자인 노드가 그릴 수 없다고 묻는다 |
| **Codex CLI** | 역할마다 Claude 대신 쓸 수 있다 | 모든 역할을 Claude가 한다 | 설치하고 `codex login` |

MCP 서버는 Codex에 연결해도 된다(`codex mcp add`). 연결 여부는 실행할 때마다 확인하므로 설정을 바꾸지 않아도 연결하는 즉시 쓰인다.
인증이 안 된 서버는 연결된 것으로 치지 않는다.

---

## 2. 예제로 먼저 해 보기

`examples/meeting-report/`는 요구사항 셋(API 둘, 화면 하나)을 스펙부터 검증 완료까지 진행해 둔 대상 프로젝트다.

```sh
cd examples/meeting-report
npm install                   # Playwright
fsd status                    # 셋 다 verified
fsd show UI-01                # 요구사항, 스펙, 디자인, 검사 계획
npx playwright test           # QA가 쓴 E2E 63개
npm start                     # http://localhost:3000 에서 화면 확인
```

볼 만한 것:

| 파일 | 무엇 |
|---|---|
| `requirements/UI-01.md` | 사람이 쓴 요구사항 |
| `specs/UI-01/spec.json` | spec 노드가 쓰고 사람이 승인한 스펙 (인수 조건 21개) |
| `design/ui.md`, `design/ux.md` | 디자인 언어. 맨 아래에 검토에서 정해진 규칙이 쌓여 있다 |
| `designs/UI-01/index.html` | design 노드가 그린 디자인 |
| `web/index.html`, `app/server.mjs` | dev 노드의 프론트엔드·백엔드가 동시에 구현한 것 |
| `e2e/UI-01/qa-plan.json` | QA가 세운 검사 계획 (어디를 무엇을 근거로 검사하는지) |
| `.fsd/runs/` | 에이전트 호출마다 모델, 토큰, 비용 |

---

## 3. 내 프로젝트에서 시작하기

대상 프로젝트의 폴더에서 한다.

**① `AGENTS.md`를 쓴다.** 에이전트가 가장 먼저 읽는 문서다. 여기에 없는 것은 에이전트가 질문한다.

```markdown
# <프로젝트 이름>
## 구조와 도구
- 언어, 프레임워크, 진입점, 서버를 띄우는 명령과 주소
- 화면이 있으면 어디에 두는지
## E2E 테스트
- 테스트 도구, 파일 위치(e2e/<요구사항 ID>/), 서버를 띄우고 닫는 법, 실행 명령
```

**② `fsd init`** — 요구사항을 Linear에서 가져올지 묻는다.
- 가져온다고 하면 Linear를 살펴보고 프로젝트·팀 후보를 진행할 이슈가 많은 순으로 보여 준다. 번호를 고르면 된다.
  고른 범위에서 **시작 전이거나 진행 중인 이슈만** 가져온다(백로그는 가져오지 않는다).
- 가져오지 않는다고 하면 `requirements/<ID>.md`를 직접 쓴다.

**③ `fsd.config.json`에 E2E 실행 명령을 적는다.** `{id}`는 요구사항 ID로 바뀐다. 종료 코드 0이면 통과다. 승인된 스펙이나 디자인이 달라지면 `verify`가 사람에게 확인을 요청한다.

```json
{ "verify": { "command": "npx playwright test e2e/{id}/" } }
```

**④ 화면이 있는 요구사항이 있으면 디자인 언어를 쓴다.** `design/ui.md`(색, 글꼴, 간격, 컴포넌트, 문구)와 `design/ux.md`(화면의 상태, 동작의 피드백, 키보드, 화면 크기).
없으면 디자인을 그리지 않고 스펙 단계로 되돌린다. 예제의 두 문서를 고쳐 쓰는 것부터 시작하면 된다.

**⑤ 요구사항을 준비한다.** `fsd pull`(Linear) 또는 파일을 직접 쓴다.

```markdown
---
id: TASK-01
title: 액션 아이템 목록 조회
priority: P0              # P0, P1, P2
depends: [AUTH-01]        # 선택. 먼저 스펙이 확정되어야 하는 요구사항
policies: [newest-first]  # 선택. 근거 정책 (policies/<이름>.md)
design: false             # 선택. 없으면 spec 노드가 판단한다
---
무엇이 되어야 하는지 적는다.
```

---

## 4. 쓰는 흐름

노드를 한 사이클씩 돌리고, 사람 차례가 오면 답한다.

```sh
fsd tick spec        # 스펙 초안 또는 질문
fsd tick design      # 디자인이 필요한 것만. 초안 또는 질문
fsd tick dev         # 구현. 디자인이 있으면 백엔드·프론트엔드 동시에
fsd tick verify      # QA가 검사 계획과 E2E를 쓰고, 설정의 명령으로 판정
fsd tick audit       # 확정된 스펙 전체에서 서로 어긋나는 곳을 찾는다
fsd status           # "대기 사유"가 있으면 사람 차례
fsd cost             # 어디에 비용이 들었는지
```

할 일이 없는 노드는 에이전트를 부르지 않고 바로 끝난다. 그래서 네 개를 차례로 반복해 돌려도 된다.

### 사람이 할 일

| `fsd status`의 대기 사유 | 할 일 |
|---|---|
| `질문 대기 Q3(spec)` | `fsd show <ID>`로 읽고 `fsd answer <ID> "<답>"` |
| `질문 대기 Q8(audit)` | 스펙끼리 어긋난다는 지적. 고치려면 `fsd respec <ID> "<사유>"`, 문제가 아니면 `fsd answer <ID> "<이유>"` |
| `승인 대기 A5(spec)` | `fsd show <ID>`로 스펙을 읽고 `fsd approve <ID>` 또는 `fsd reject <ID> "<사유>"` |
| `승인 대기 A7-ui(design)`, `A7-ux(design)` | 디자인을 열어 보고 관점별로 `fsd approve <ID> --ui`, `--ux`. 반려는 `fsd reject <ID> "<지적>" --ui` |

- 지적은 느낌으로 써도 된다("좀 약해 보인다"). 디자인 노드가 검사할 수 있는 규칙으로 바꾸고, 뜻이 둘 이상이면 선택지를 들어 되묻는다.
  다른 화면에도 적용할 규칙은 디자인이 승인될 때 `design/ui.md`나 `ux.md`에 쌓인다.
- 확정한 스펙을 다시 열려면 `fsd respec <ID> "<사유>"`.
- 같은 E2E 실패가 2번 연속되거나, 재작업이 3번, 반려가 3번에 닿으면 노드가 더 시도하지 않고 묻는다.

---

## 5. 명령

```
fsd init [--linear [--project 이름|--team 이름]|--no-linear]   요구사항을 Linear에서 가져올지 정한다
fsd pull [--dry-run]                     Linear의 이슈를 요구사항 파일로 가져온다
fsd status [--json]                      요구사항별 상태, 세부 단계, 대기 사유
fsd show <ID>                            요구사항, 결정, 스펙, 디자인, 검사 계획, 버그
fsd next <spec|design|dev|verify>        노드가 다음에 고를 요구사항 (실행하지 않음)
fsd tick <spec|design|dev|verify|audit>  노드를 한 사이클 실행 [--agent claude|codex]
fsd answer <ID> <답> [질문 번호]          질문에 답한다
fsd approve <ID> [--ui|--ux]             초안을 승인한다
fsd reject <ID> <사유> [--ui|--ux]       초안을 반려한다
fsd respec <ID> <사유>                   확정된 스펙을 다시 연다
fsd cost [--json]                        에이전트 호출 비용: 전체, 요구사항별, 노드별, 에이전트별
fsd sync                                 요구사항 파일의 변경만 반영한다 (모든 명령 앞에서 저절로 돈다)
```

## 6. 설정 (`fsd.config.json`)

적지 않은 것은 기본값을 쓴다. 자세한 것은 [docs/usage.md](docs/usage.md#6-설정-fsdconfigjson).

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
  "prices": { "codex": { "inputPer1M": 1.25, "outputPer1M": 10 } }
}
```

`prices`는 비용을 알려 주지 않는 codex의 100만 토큰당 단가다. 위 값은 예시이니 실제 단가를 확인해서 적는다. 없으면 `fsd cost`가 "가격 미설정"으로 보여 준다.

에이전트에게 주는 규칙은 이 저장소의 `skills/*.md`다. 대상 프로젝트에 같은 이름의 `skills/<이름>.md`를 두면 그것을 대신 쓴다.

## 7. 알아 둘 것

- **비용.** 에이전트 호출 한 번에 $0.2~$1.5가 든다. 화면 요구사항 하나를 스펙부터 검증까지 진행하는 데 약 $4가 들었다(Claude Opus 5.5). 호출마다 `.fsd/runs/`에 남는다.
  역할에 작은 모델을 지정하면 줄어든다.
- **Codex 샌드박스에서는 브라우저가 뜨지 않는다.** Codex가 구현이나 QA를 맡으면 자기 환경에서 화면을 직접 확인하지 못하고, 확인하지 못한 것을 메모에 남긴다.
  판정은 verify가 샌드박스 밖에서 설정의 명령으로 하므로 결과에는 영향이 없다.
- **한 폴더에서 `tick`을 동시에 여러 개 돌리지 않는다.** 같은 요구사항을 두 번 집는 것을 막는 장치가 아직 없다.
- 처음에는 질문이 많다. 질문이 반복되면 요구사항, 정책, 디자인 언어에 그 내용이 빠져 있다는 신호다. 거기에 적어 두면 다음부터 묻지 않는다.

## 8. 문서

| 문서 | 내용 |
|---|---|
| [docs/usage.md](docs/usage.md) | 사용 방법의 자세한 판. 단계별 동작, 상태 읽는 법, 설정, 실측 비용 |
| [docs/why.md](docs/why.md) | 왜 이렇게 만들었나. 결정과 이유, 치른 것, 실제로 돌려 보고 고친 것, 아직 없는 것 |
| [docs/graph.md](docs/graph.md) | 상태, 기다림, 전이 규칙, 플래그의 전체 표. 코드가 따르는 기준 문서 |

## 9. 저장소 구조

| 경로 | 내용 |
|---|---|
| `src/cli.ts` | 명령 |
| `src/transitions.ts`, `src/sync.ts`, `src/select.ts`, `src/flags.ts` | 전이 규칙, 변경 감지, 후보 선택, 세부 단계와 반복 한도 |
| `src/nodes/` | 노드의 한 사이클: `spec`, `design`, `dev`, `verify` |
| `src/spec.ts`, `src/design.ts`, `src/qa.ts` | 산출물의 형식과 코드 검사 |
| `src/agents/` | AI와의 계약(`Agent`), Claude·Codex 어댑터, 연결된 외부 도구 확인 |
| `src/init.ts`, `src/sources/linear.ts` | 처음에 묻기, Linear에서 요구사항 가져오기 |
| `skills/` | 역할별 규칙 문서 |
| `test/` | 테스트 (`npm test`, `npm run typecheck`) |
| `examples/meeting-report/` | 예제 대상 프로젝트 |

대상 프로젝트 안에 생기는 것:

| 경로 | 누가 쓰나 |
|---|---|
| `requirements/`, `policies/`, `design/`, `AGENTS.md`, `fsd.config.json` | 사람 (`requirements/`는 `fsd pull`도) |
| `specs/<ID>/`, `designs/<ID>/`, `e2e/<ID>/` | spec, design, verify 노드 |
| `.fsd/` | 도구: 상태와 이력, 호출 기록, 인계 메모 |

## 라이선스

[MIT](LICENSE)
