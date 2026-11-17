## 2026-11-17T07:07:11.242Z 구현

- 진입점: `app/server.mjs`. `createServer(options)`는 listen하지 않은 `http.Server`를 돌려준다. `options.tasks`는 `{ id, title, createdAt }` 배열이고 생략하면 비어 있다.
- 구조: `routes` 객체에 `'METHOD /path'` 키로 핸들러를 등록한다(`(store) => ({ status, body })`). 데이터는 `createServer` 안의 `store.tasks`(메모리)에 있다. 새 엔드포인트는 `routes`에 추가하면 된다.
- `createdAt`은 넣을 때 `toUtcString`으로 ISO 8601 UTC로 맞춘다. 밀리초가 0이면 `2026-11-17T06:10:16Z`처럼 초까지만, 0이 아니면 밀리초를 남긴다. 잘못된 날짜 값을 넣으면 `createServer`에서 RangeError가 난다(스펙이 정하지 않은 입력).
- 스펙에 없는 것: 등록되지 않은 경로·메서드는 `404`와 `{"error":"Not Found"}`를 돌려주게 해 두었다. 스펙이 오류 응답을 정하지 않아 임의로 둔 기본값이므로, 나중 스펙이 정하면 그에 맞춰 바꾼다.
- 실행: `npm start`(환경 변수 `PORT`, 기본 3000) 후 `curl localhost:3000/tasks`. E2E는 `npx playwright test e2e/TASK-01/`.
- 확인 방법: 이번에는 `createServer({ tasks })`를 `listen(0)`으로 띄워 `fetch`로 직접 확인했다. `e2e/` 디렉터리는 아직 없어 Playwright E2E는 돌리지 못했다. 저장소에 단위 테스트 방식이 없어 단위 테스트는 쓰지 않았다.
- Node v26.3.0에서 확인했다. `Array.prototype.toSorted`를 쓰므로 Node 20 이상이 필요하다.

