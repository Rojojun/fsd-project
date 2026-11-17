# 그래프 규칙

요구사항 하나하나가 아래 상태 중 하나에 있고, 노드는 전이 규칙 표에 있는 길로만 상태를 옮긴다.
코드의 `src/transitions.ts`는 이 문서를 그대로 옮긴 것이다. 둘이 다르면 이 문서를 먼저 고친다.

## 노드

| 노드 | 종류 | 하는 일 |
|---|---|---|
| sync | 코드 | 요구사항 파일의 지문을 비교해 등록·변경·폐기를 반영한다. 모든 명령 실행 전에 돈다. |
| spec | AI + 코드 | 요구사항을 API 계약·인수 조건·E2E로 확정할 초안을 만든다. |
| dev | AI + 코드 | 확정 스펙을 구현한다. |
| verify | 코드 (+AI 버그 리포트) | E2E를 실행해 통과하면 승격, 실패하면 버그를 기록한다. |
| audit | AI + 코드 | 확정 스펙 전체의 교차 모순을 찾아 사람에게 묻는다. |

기획은 사람이 요구사항 파일(`requirements/*.md`)을 직접 쓴다. 발표의 Upstream(기획서 → 요구사항 변환)은 두지 않고,
변경 감지만 `sync`가 맡는다. 자유 형식 기획서(Confluence 등)를 받아야 할 때는 요구사항 파일을 써 주는 입력 어댑터로 붙인다.

## 상태

| 상태 | 이름 | 의미 |
|---|---|---|
| `cataloged` | 등록됨 | 요구사항은 있고 승인된 스펙은 없다. |
| `specified` | 스펙 확정 | 사람이 승인한 스펙이 있다. dev의 후보다. |
| `in-dev` | 구현 중 | dev가 착수했거나 버그를 재작업하는 중이다. |
| `implemented` | 구현 완료 | verify를 기다린다. |
| `verified` | 검증 완료 | E2E를 통과했다. |
| `stale` | 재확정 필요 | 스펙 확정 뒤 요구사항이 바뀌었거나, 사람이 스펙 수정을 결정했다. |
| `deprecated` | 폐기 | 요구사항 파일이 삭제되었거나 `deprecated: true`다. |

## 대기 사유 (hold)

상태와 별개로 어느 상태에든 붙는다. hold가 하나라도 있으면 노드(spec·dev·verify·audit)는 그 요구사항을 건너뛴다.

| 종류 | 이름 | 붙이는 쪽 | 푸는 쪽 |
|---|---|---|---|
| `question` | 질문 대기 | 모든 노드 | 사람 `answer` |
| `approval` | 승인 대기 | spec (초안 제출) | 사람 `approve` / `reject` |

승인 대기는 초안의 해시에 묶인다. 초안이 바뀌면 이전 승인은 쓸 수 없다.

## 전이 규칙

"유지"는 상태를 바꾸지 않고 hold만 붙이거나 뗀다는 뜻이다.

| 전이 | 주체 | from | to | 조건 · 효과 |
|---|---|---|---|---|
| register | sync | (없음) | cataloged | 새 요구사항 파일 |
| reset | sync | cataloged, stale | 유지 | 파일 변경. 초안과 hold를 버린다. |
| invalidate | sync | specified, in-dev, implemented, verified | stale | 파일 변경. hold와 버그를 버린다. |
| deprecate | sync | deprecated 외 전부 | deprecated | 파일 삭제 또는 `deprecated: true`. hold를 버린다. |
| revive | sync | deprecated | cataloged | 파일 복원 |
| draftSpec | spec | cataloged, stale | 유지 | 승인 대기 hold 추가 (초안 해시) |
| ask | spec, dev, verify, audit | deprecated 외 전부 | 유지 | 질문 대기 hold 추가 |
| answer | 사람 | 질문 대기가 있는 상태 | 유지 | 질문 hold 제거, 결정 기록 추가 |
| approveSpec | 사람 | cataloged, stale + 승인 대기 | specified | 초안 해시 일치 시. 승인 스펙 해시 기록 |
| reject | 사람 | 승인 대기가 있는 상태 | 유지 | 승인 hold 제거, 피드백 기록 |
| startDev | dev | specified | in-dev | |
| finishDev | dev | in-dev | implemented | 구현 기준 스펙 해시 = 승인 스펙 해시 (Spec Gate) |
| passVerify | verify | implemented | verified | 버그 기록 제거 |
| failVerify | verify | implemented | in-dev | 버그 증거 기록 |
| respec | 사람 | specified, in-dev, implemented, verified | stale | 사람이 스펙 수정을 결정 (audit 질문의 답 등) |

## 후보 선택

| 노드 | 후보 | 순서 | 제외 |
|---|---|---|---|
| spec | cataloged, stale | 우선순위(P0→P2), ID | hold 있음, 선행 요구사항이 specified 이전, 승인 대기 수 ≥ WIP 한도 |
| dev | in-dev(버그) → in-dev → specified | 같은 그룹 안에서는 우선순위, ID | hold 있음 |
| verify | implemented | 우선순위, ID | hold 있음 |

## 플래그

상태 7개는 "어디에 있는가"만 말한다. 플래그는 "그 안에서 왜, 무엇을 기다리는가"를 말한다.
플래그는 저장하지 않고 상태와 이력에서 매번 계산한다(`src/flags.ts`). `agdd status --json`으로 내보낸다.

### 세부 단계 (phase)

요구사항마다 하나다. 위에서부터 먼저 해당하는 것을 쓴다.

| phase | 의미 | 나오는 상태 |
|---|---|---|
| `closed` | 폐기됨 | deprecated |
| `waiting-answer` | 사람의 답을 기다린다 | 전부 |
| `waiting-approval` | 사람의 승인을 기다린다 | cataloged, stale |
| `blocked-by-dependency` | 선행 요구사항의 스펙이 확정되지 않았다 | cataloged, stale |
| `redraft` | 초안이 반려되어 다시 써야 한다 | cataloged, stale |
| `building` | 처음 구현하는 중이다 | in-dev |
| `rework` | E2E 실패로 되돌아와 고치는 중이다 | in-dev |
| `done` | 끝났다 | verified |
| `ready` | 담당 노드가 집어 갈 수 있다 | cataloged, stale, specified, implemented |

### 사실 값

| 플래그 | 의미 | 다시 0부터 세는 때 |
|---|---|---|
| `blockedBy` | 막고 있는 선행 요구사항 ID | |
| `staleReason` | `requirement-changed`(파일 변경) / `respec`(사람 결정) | |
| `rejections` | 스펙 초안 반려 횟수 | 요구사항 변경, respec, 사람의 답 |
| `reworks` | E2E 실패로 되돌아온 횟수 | 스펙 승인, 사람의 답 |
| `sameFailureStreak` | 같은 증거로 연속 실패한 횟수 | 스펙 승인, 사람의 답 |
| `waitingSince` | 가장 오래된 대기가 시작된 시각 | |

### 반복 한도 (escalate)

sync 직후에 코드가 검사한다. 한도에 닿으면 질문 대기를 붙여 사람에게 넘기고, 노드는 더 시도하지 않는다.
한도는 `agdd.config.json`의 `limits`로 바꾼다.

| 조건 | 기본 한도 | 묻는 쪽 |
|---|---|---|
| `rejections` | 3 | spec |
| `sameFailureStreak` | 2 | dev |
| `reworks` | 3 | dev |

## 과적합을 막는 규칙

여기서 과적합은 두 가지다. 규칙이 특정 사례에만 맞게 불어나는 것, 그리고 AI가 요구사항이 아니라 검사를 통과하는 데 맞추는 것.

**규칙 쪽**

1. 플래그는 저장하지 않고 계산한다. 새 경우가 생겨도 상태 파일에 필드를 더하지 않는다.
2. phase 낱말은 상태마다 따로 만들지 않고 전체가 나눠 쓴다. 새 낱말은 기존 낱말로 표현할 수 없을 때만 더한다.
3. 요구사항 ID, 제목, 본문 내용에 따라 갈리는 규칙을 코드에 두지 않는다. 코드는 상태, 대기, 이력만 본다.
4. 한도 같은 숫자는 코드에 박지 않고 설정으로 둔다.

**AI 쪽**

| 규칙 | 막는 것 | 적용 |
|---|---|---|
| 같은 실패가 반복되면 사람에게 넘긴다 | 통과할 때까지 같은 시도를 되풀이 | 지금 (escalate) |
| 구현 기준 스펙 해시 = 승인 스펙 해시 (Spec Gate) | dev가 스펙이나 E2E를 고쳐서 통과 | 지금 (전이 규칙), 3단계에서 디스크의 스펙 파일 해시로 계산 |
| 승인은 초안 해시에 묶인다 | 승인 뒤 초안을 바꿔치기 | 지금 (전이 규칙) |
| verify는 dev와 다른 프로세스에서 승인된 E2E를 실행한다 | dev가 스스로 통과를 선언 | 3단계 |
| 스펙 작성과 리뷰를 다른 모델에 맡길 수 있다 | 작성자의 오해를 같은 눈으로 검토 | 2단계 (역할별 모델 설정) |
| 인수 조건 필수 항목은 코드가 검사한다 | 모델마다 다른 스펙 품질 | 2단계 |
| audit은 사람이 쓴 정책(`policies/`)과 스펙을 대조한다 | 스펙과 E2E가 같은 오해를 공유 | 4단계 |

마지막 줄의 한계: 스펙과 E2E를 같은 쪽이 쓰면 오해가 담긴 코드도 통과한다. 규칙은 근거가 있는지는 검사해도 근거를 제대로 이해했는지는 검사하지 못한다.
그래서 스펙 승인은 사람이 하고, 스펙 초안은 사람이 읽기 쉬워야 한다.
