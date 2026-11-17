## 2026-11-17T07:09:13.263Z 구현

- 진입점·주요 파일: `app/server.mjs` 하나. `routes`가 객체에서 배열(`{ method, pattern(정규식), handle }`)로 바뀌었다. `dispatch(store, method, pathname)`가 맞는 라우트를 찾아 `handle(store, ...경로 매개변수)`를 부르고, 없으면 `notFound`(404, `{"error":"Not Found"}`)를 돌려준다. 새 엔드포인트는 `routes` 배열에 추가한다.
- 완료 처리: `completeTask(store, id)`. `store.tasks`를 새 배열로 바꿔 넣는다(해당 항목만 `completed: true`). 이미 완료된 항목도 같은 200 응답.
- 액션 아이템 필드는 `id`, `title`, `createdAt`, `completed`. `toTask`가 넣을 때 `completed`를 불리언으로 맞춘다.
- 스펙에 없는데 내가 정한 것(안쪽 인터페이스): `createServer({ tasks })`의 처음 데이터에 `completed: true`를 넣으면 완료 상태로 시작한다. 생략하거나 `true`가 아니면 `false`. QA가 "이미 완료된 액션 아이템이 저장되어 있다"는 조건을 시드로 만들 수 있게 한 것이다(POST로 만들어도 된다).
- 스펙에 없는 것: 404 본문은 `{"error":"Not Found"}`(스펙은 본문을 정하지 않음). `{id}`는 URL 디코딩해서 비교하고, 잘못된 퍼센트 인코딩이면 404.
- 실행: `npm start`(`PORT`, 기본 3000) 후 `curl -X POST localhost:3000/tasks/<id>/complete`. E2E는 `npx playwright test e2e/<요구사항 ID>/`.
- 확인: `createServer`를 `listen(0)`으로 띄워 `fetch`로 AC-1~AC-10을 확인했다(임시 스크립트는 저장소 밖 `/tmp`에 두었고 저장소에는 남기지 않았다). `e2e/TASK-02/`는 아직 없어 돌리지 못했다. `e2e/TASK-01/`은 9개 모두 통과. 저장소에 단위 테스트 방식이 없어 단위 테스트는 쓰지 않았다.
- 커밋하지 않았다(작업 트리에 `app/server.mjs` 변경만 있음).

