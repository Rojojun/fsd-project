---
id: TASK-01
title: 액션 아이템 목록 조회
priority: P0
policies: [newest-first]
---
회의 보고 시스템에서 액션 아이템 목록을 조회한다.

- `GET /tasks`는 액션 아이템 목록을 JSON 배열로 돌려준다.
- 목록은 생성일 기준으로 정렬한다.
- 액션 아이템이 없으면 빈 배열을 돌려준다.
