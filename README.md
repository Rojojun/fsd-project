# agdd — 자율 그래프 주도 개발 CLI

[NAVER D2 발표 "자율 그래프 주도 개발"](https://d2.naver.com/helloworld/5976687)의 구조를 로컬 CLI로 옮기는 프로젝트다.
사람은 요구사항을 쓰고 질문에 답하고 승인한다. 나머지는 노드가 저장소 상태를 읽고 한 단계씩 진행한다.
노드가 부르는 AI는 Claude, Codex 등으로 바꿔 끼울 수 있게 만든다.

Node.js 24 이상이 필요하다. TypeScript를 빌드 없이 실행한다.

```sh
npm install
npm test
node src/cli.ts status
```

## 구조

| 경로 | 내용 |
|---|---|
| `docs/graph.md` | 상태, 대기 사유, 전이 규칙. 이 프로젝트의 기준 문서 |
| `requirements/<ID>.md` | 사람이 쓰는 요구사항. YAML 머리말 + 본문 |
| `policies/<ID>.md` | 요구사항이 근거로 드는 정책 |
| `.agdd/state/<ID>.json` | 요구사항별 상태와 이력. 도구가 쓴다 |
| `src/transitions.ts` | 전이 규칙 (순수 함수) |
| `src/sync.ts` | 요구사항 파일 변경 감지 |
| `src/select.ts` | 노드별 후보 선택과 WIP 한도 |
| `src/flags.ts` | 세부 단계와 반복 횟수 계산, 반복 한도 |
| `src/spec.ts` | 스펙 형식, 출력 검사, 스펙 해시 |
| `src/agents/` | Agent 계약과 어댑터 (claude, codex) |
| `src/nodes/spec.ts` | spec 노드의 한 사이클 |
| `skills/spec-writer.md` | 스펙 작성 규칙. 어느 모델에나 같은 문서를 준다 |
| `specs/<ID>/` | 스펙. 승인은 이 폴더의 해시에 묶인다 |
| `.agdd/runs/` | 에이전트 호출 기록 (모델, 토큰, 비용) |
| `src/cli.ts` | 명령 |
| `legacy-mvp/` | 첫 번째 단일 파일 예제 (참고용) |

## 명령

```
agdd status [--json]            요구사항별 상태, 세부 단계, 대기 사유
agdd sync                       요구사항 파일 변경만 반영
agdd show <ID>                  요구사항 하나의 상태, 질문, 스펙 초안
agdd next <spec|dev|verify>     노드가 다음에 고를 후보 (실행하지 않음)
agdd tick spec [--agent 이름]   spec 노드를 한 사이클 실행 (claude | codex)
agdd answer <ID> <답> [Q번호]   열린 질문에 답한다
agdd approve <ID>               승인 대기 중인 스펙을 확정한다
agdd reject <ID> <사유>         승인 대기 중인 스펙을 반려한다
agdd respec <ID> <사유>         확정된 스펙을 다시 연다
```

모든 명령은 실행 전에 요구사항 파일을 다시 읽는다. 파일이 바뀌었으면 그 요구사항의 초안과 승인은 무효가 된다.

## 에이전트

노드는 AI를 `Agent`라는 함수로만 안다. 과제(프롬프트, 결과 형식, 작업 폴더, 접근 범위, 한도)를 주면 결과(출력 또는 실패 사유, 사용량)를 돌려준다.
`claude -p`와 `codex exec`는 안에서 도구를 쓰며 여러 턴을 도는 에이전트다. 여러 에이전트를 묶은 함수도 같은 `Agent`이므로,
작업 단위 하나를 작성자+리뷰어 같은 멀티에이전트로 바꿔도 노드와 그래프는 바뀌지 않는다.

역할별 에이전트와 한도는 `agdd.config.json`으로 정한다. 없으면 아래가 기본값이다.

```json
{
  "roles": { "spec-writer": { "agent": "claude" } },
  "agent": { "timeoutMs": 600000, "maxTurns": 30 },
  "wip": { "spec": 3 },
  "limits": { "rejections": 3, "reworks": 3, "sameFailure": 2 }
}
```

`roles`의 항목에 `"model"`을 주면 그 모델로 실행한다.

## 진행 상황

- [x] 1단계: 상태·전이 규칙·sync·후보 선택·사람 명령 (AI 없음)
- [x] 2단계: Agent 어댑터 (claude, codex)와 `agdd tick spec`
- [ ] 3단계: `tick dev`, `tick verify`
- [ ] 4단계: `tick audit`, 비용 집계
- [ ] 5단계: 트리거(cron/CI)와 GitHub·GitLab 채널 어댑터
