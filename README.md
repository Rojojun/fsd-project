# agdd — 자율 그래프 주도 개발 CLI

요구사항 하나하나를 스펙 → (디자인) → 구현 → 검증으로 옮기는 도구다.
사람은 요구사항을 쓰고, 질문에 답하고, 초안을 승인한다. 나머지는 노드가 저장소의 상태를 읽고 한 걸음씩 진행한다.
노드가 부르는 AI는 Claude, Codex 가운데 역할마다 골라 쓴다.

[NAVER D2 발표 "자율 그래프 주도 개발"](https://d2.naver.com/helloworld/5976687)의 구조를 로컬 CLI로 옮긴 것이다.

```
요구사항 ──▶ spec ──▶ (design) ──▶ dev ──▶ verify ──▶ 끝
(파일/Linear)   │         │          │        │
              질문·승인  질문·승인    질문    실패하면 dev로
```

## 문서

| 문서 | 내용 |
|---|---|
| [docs/usage.md](docs/usage.md) | **사용 방법.** 준비, 단계별 명령, 사람이 할 일, 설정 |
| [docs/why.md](docs/why.md) | **왜 이렇게 만들었나.** 결정과 이유, 치른 것, 아직 없는 것 |
| [docs/graph.md](docs/graph.md) | 상태, 기다림, 전이 규칙, 플래그의 전체 표. 코드가 따르는 기준 문서 |

## 빠르게 해 보기

Node.js 24 이상이 필요하다. TypeScript를 빌드 없이 실행한다.

```sh
npm install && npm test

cd examples/meeting-report        # 예제 대상 프로젝트
npm install
node ../../src/cli.ts status      # 요구사항 둘이 검증 완료까지 진행된 상태
node ../../src/cli.ts show TASK-02
npx playwright test               # QA가 쓴 E2E 25개
```

## 내 프로젝트에서 시작하기

대상 프로젝트의 폴더에서 한다. 아래에서 `agdd`는 `node <이 저장소>/src/cli.ts`다.

1. **`AGENTS.md`를 쓴다.** 프로젝트의 구조, 쓰는 도구, 서버를 띄우는 법, 테스트 쓰는 법. 에이전트가 이것부터 읽는다.
2. **`agdd init`을 실행한다.** 요구사항을 Linear에서 가져올지 묻는다.
   - 가져온다고 하면 Linear를 살펴보고 범위의 후보(프로젝트, 팀)를 보여 준다. 번호를 고르면 된다.
   - 가져오지 않는다고 하면 `requirements/<ID>.md`를 직접 쓴다.
3. **`agdd.config.json`에 E2E 실행 명령을 적는다.** 예: `{ "verify": { "command": "npx playwright test e2e/{id}/" } }`
4. 요구사항을 준비한다: `agdd pull` (Linear) 또는 파일을 직접 쓴다.
5. 노드를 돌린다: `agdd tick spec` → 질문에 답하고 승인 → `agdd tick dev` → `agdd tick verify`.
   `agdd status`의 "대기 사유"에 무엇이 있으면 사람 차례다.

자세한 것은 [docs/usage.md](docs/usage.md)에 있다.

## 명령

대상 프로젝트의 폴더에서 실행한다.

```
agdd init                                처음 한 번: 요구사항을 Linear에서 가져올지 정한다
agdd pull [--dry-run]                    Linear의 이슈를 요구사항 파일로 가져온다
agdd status [--json]                     요구사항별 상태, 세부 단계, 기다림
agdd show <ID>                           요구사항, 결정, 스펙, 디자인, 검사 계획
agdd next <spec|design|dev|verify>       노드가 다음에 고를 요구사항 (실행하지 않음)
agdd tick <spec|design|dev|verify>       노드를 한 사이클 실행 [--agent claude|codex]
agdd answer <ID> <답> [질문 번호]         질문에 답한다
agdd approve <ID> [--ui|--ux]            초안(스펙 또는 디자인)을 승인한다
agdd reject <ID> <사유> [--ui|--ux]      초안을 반려한다
agdd respec <ID> <사유>                  확정된 스펙을 다시 연다
agdd sync                                요구사항 파일의 변경만 반영한다 (모든 명령 앞에서 저절로 돈다)
```

## 저장소 구조

| 경로 | 내용 |
|---|---|
| `src/transitions.ts` | 전이 규칙. `docs/graph.md`의 표를 옮긴 것 |
| `src/sync.ts`, `src/select.ts`, `src/flags.ts` | 변경 감지, 노드별 후보 선택, 세부 단계와 반복 한도 |
| `src/nodes/` | 노드의 한 사이클: `spec`, `design`, `dev`, `verify` |
| `src/spec.ts`, `src/design.ts`, `src/qa.ts` | 산출물의 형식과 코드 검사 |
| `src/agents/` | AI와의 계약(`Agent`)과 어댑터(claude, codex), 연결된 외부 도구 확인 |
| `src/init.ts`, `src/sources/linear.ts` | 처음에 묻기, Linear를 살펴보고 이슈를 요구사항 파일로 옮겨 적기 |
| `src/notes.ts` | 실행 사이의 인계 메모 |
| `src/cli.ts`, `src/store.ts` | 명령, 설정과 상태 저장 |
| `skills/` | 역할별 규칙 문서. 어느 모델에나 같은 문서를 준다 |
| `test/` | 테스트. `npm test` |
| `examples/meeting-report/` | 예제 대상 프로젝트 |
| `legacy-mvp/` | 첫 번째 단일 파일 예제 (참고용) |

대상 프로젝트 안에 생기는 것:

| 경로 | 내용 | 누가 쓰나 |
|---|---|---|
| `requirements/<ID>.md` | 요구사항 | 사람 (또는 `agdd pull`) |
| `policies/<이름>.md` | 요구사항이 근거로 드는 정책 | 사람 |
| `design/ui.md`, `design/ux.md` | 디자인 언어 | 사람 (승인된 검토 규칙이 쌓인다) |
| `AGENTS.md`, `agdd.config.json` | 프로젝트의 방식, 설정 | 사람 |
| `specs/<ID>/` | 스펙 | spec 노드 |
| `designs/<ID>/` | 디자인 | design 노드 |
| `e2e/<ID>/` | 검사 계획과 E2E 테스트 | verify 노드의 QA |
| `.agdd/state/` | 요구사항별 상태와 이력 | 도구 |
| `.agdd/runs/`, `.agdd/notes/`, `.agdd/qa/` | 호출 기록, 인계 메모, 검사 계획의 근거 | 도구 |

## 진행 상황

- [x] 상태, 전이 규칙, 변경 감지, 후보 선택, 사람의 명령
- [x] 에이전트 어댑터(claude, codex)와 spec 노드
- [x] design 노드: 도구 선택(Penpot → Figma → HTML), 디자인 언어, UI·UX 두 관점의 검토, 지적의 명문화
- [x] dev 노드: 디자인이 있으면 백엔드·프론트엔드 병렬
- [x] verify 노드: QA 검사 계획의 대조, 설정된 E2E 명령
- [x] Linear에서 요구사항 가져오기 (처음에 쓸지 묻고, 범위는 후보에서 고른다)
- [ ] audit 노드, 비용 집계
- [ ] PR 채널(질문·승인·반려, 화면 캡처), 자동 실행

실제 모델로 끝까지 돌려 본 길과 아직 돌려 보지 못한 길은 [docs/why.md](docs/why.md)의 끝에 적었다.
