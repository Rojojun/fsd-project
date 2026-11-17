---
id: TASK-02
title: 액션 아이템 완료 처리
priority: P1
depends: [TASK-01]
---
액션 아이템을 완료 상태로 바꾼다.

- `POST /tasks/{id}/complete`는 해당 액션 아이템을 완료로 표시한다.
- 완료된 액션 아이템은 목록 조회 결과에 완료 여부와 함께 나온다.
- 없는 ID면 404를 돌려준다.
