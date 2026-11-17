# 자율 그래프 주도 개발 MVP

[NAVER D2 발표](https://d2.naver.com/helloworld/5976687)의 흐름을 로컬 CLI로 구현한 예제입니다. 회의 보고 시스템의 액션 아이템 조회를 샘플로 사용합니다. Node.js 22 이상이 필요합니다.

```sh
node graph.mjs run
node graph.mjs answer desc
node graph.mjs status
node graph.mjs approve
node graph.mjs status
```

1. Upstream이 `plan.json`의 파일 지문을 읽고 변경을 등록합니다.
2. Spec-drive가 정렬 방향을 질문하고, 답변을 받으면 API 계약과 인수 조건을 만듭니다.
3. 사람의 승인이 기록되면 Dev가 앱을 생성합니다. 데모에서 첫 구현은 의도적으로 오름차순을 사용합니다.
4. Verify가 실제 HTTP 핸들러를 프로세스 안에서 호출해 응답 코드·JSON·정렬·빈 목록을 검사합니다. 실패 로그와 스펙 버전을 남기고 Dev가 재작업합니다.
5. 계약 테스트가 통과하면 Audit가 최신순 정책과 스펙을 대조합니다.

Audit 경로는 별도 실행 디렉터리에서 `AGDD_WORKSPACE=.audit-demo node graph.mjs run`으로 시작하고, 같은 환경 변수로 `answer asc`와 `approve`를 호출해서 볼 수 있습니다. 계약 테스트는 오름차순 스펙을 충족하지만 Audit가 최신순 정책 위반을 감지합니다. `answer desc`와 `approve`로 스펙을 수정하고 다시 검증합니다.

상태와 이력은 기본적으로 `.agdd/state.json`에 기록됩니다. 작업 디렉터리당 한 개의 실행 프로세스를 사용합니다. 기획서 내용이 바뀌면 다음 실행에서 다시 스펙 확정을 거칩니다.

발표의 운영 환경은 독립 노드가 저장소 상태를 읽고 GitHub Enterprise에서 PR과 이슈를 처리합니다. 이 예제는 로컬 상태 머신, 템플릿 구현, 규칙 기반 감사로 두 피드백 경로를 재현합니다. 검증은 Node.js의 Request와 Response 객체를 사용하며 배포 및 네트워크 연결은 별도 단계입니다. 다음 구현은 테스트 저장소에서 독립 워커와 Codex CLI를 연결하고, 질문·스펙·코드 승인을 PR 및 이슈 이벤트로 받는 단계입니다.
