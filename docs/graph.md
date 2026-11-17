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
