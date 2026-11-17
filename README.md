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
| `src/cli.ts` | 명령 |
| `legacy-mvp/` | 첫 번째 단일 파일 예제 (참고용) |

## 명령

```
agdd status                     요구사항별 상태와 대기 사유
agdd sync                       요구사항 파일 변경만 반영
agdd next <spec|dev|verify>     노드가 다음에 고를 후보 (실행하지 않음)
agdd answer <ID> <답> [Q번호]   열린 질문에 답한다
agdd approve <ID>               승인 대기 중인 스펙을 확정한다
agdd reject <ID> <사유>         승인 대기 중인 스펙을 반려한다
agdd respec <ID> <사유>         확정된 스펙을 다시 연다
```

모든 명령은 실행 전에 요구사항 파일을 다시 읽는다. 파일이 바뀌었으면 그 요구사항의 초안과 승인은 무효가 된다.

## 진행 상황

- [x] 1단계: 상태·전이 규칙·sync·후보 선택·사람 명령 (AI 없음)
- [ ] 2단계: Agent 어댑터 (claude, codex)와 `agdd tick spec`
- [ ] 3단계: `tick dev`, `tick verify`
- [ ] 4단계: `tick audit`, 비용 집계
- [ ] 5단계: 트리거(cron/CI)와 GitHub·GitLab 채널 어댑터
