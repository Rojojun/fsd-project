## 2026-11-17T07:07:11.242Z 구현

- 진입점: `app/server.mjs`. `createServer(options)`는 listen하지 않은 `http.Server`를 돌려준다. `options.tasks`는 `{ id, title, createdAt }` 배열이고 생략하면 비어 있다.
- 구조: `routes` 객체에 `'METHOD /path'` 키로 핸들러를 등록한다(`(store) => ({ status, body })`). 데이터는 `createServer` 안의 `store.tasks`(메모리)에 있다. 새 엔드포인트는 `routes`에 추가하면 된다.
- `createdAt`은 넣을 때 `toUtcString`으로 ISO 8601 UTC로 맞춘다. 밀리초가 0이면 `2026-11-17T06:10:16Z`처럼 초까지만, 0이 아니면 밀리초를 남긴다. 잘못된 날짜 값을 넣으면 `createServer`에서 RangeError가 난다(스펙이 정하지 않은 입력).
- 스펙에 없는 것: 등록되지 않은 경로·메서드는 `404`와 `{"error":"Not Found"}`를 돌려주게 해 두었다. 스펙이 오류 응답을 정하지 않아 임의로 둔 기본값이므로, 나중 스펙이 정하면 그에 맞춰 바꾼다.
- 실행: `npm start`(환경 변수 `PORT`, 기본 3000) 후 `curl localhost:3000/tasks`. E2E는 `npx playwright test e2e/TASK-01/`.
- 확인 방법: 이번에는 `createServer({ tasks })`를 `listen(0)`으로 띄워 `fetch`로 직접 확인했다. `e2e/` 디렉터리는 아직 없어 Playwright E2E는 돌리지 못했다. 저장소에 단위 테스트 방식이 없어 단위 테스트는 쓰지 않았다.
- Node v26.3.0에서 확인했다. `Array.prototype.toSorted`를 쓰므로 Node 20 이상이 필요하다.

## 2026-11-17T08:28:56.348Z 구현

- 진입점: `app/server.mjs`. `createServer({ tasks })`에 넘기는 각 요소는 `{ id, title, createdAt, completed? }`이고, `completed`를 생략하면 false가 된다(`toTask`). 라우트는 `routes` 배열에 `{ method, pattern, handle(store, ...params) }` 형태로 등록되어 있다. 현재 등록된 것은 `GET /tasks`와 `POST /tasks/{id}/complete`(TASK-02)다. 화면 파일은 `web/`에 있고 같은 서버가 내준다.
- 정렬: `createdAt` 내림차순(`toSorted`, Node 20 이상 필요). `completed`와는 상관없다.
- 확인한 것: `npx playwright test e2e/TASK-01/ e2e/TASK-02/`를 돌려 25개 모두 통과했다. 그리고 `createServer`를 `listen(0)`에 띄우고 `fetch`로 직접 요청해 결과를 봤다.
  - AC-3: 응답이 `[{"id":"a1","title":"회의록 공유","createdAt":"2026-11-17T06:10:16Z","completed":false}]`였다.
  - AC-6: 응답 순서가 17일, 16일, 15일이었다.
  - AC-7/8: 상태 코드 200과 `[]`가 왔다.
- 기존 TASK-01 E2E에는 AC-3의 `completed:false`를 확인하는 테스트가 없다. TASK-02 E2E의 S-6, S-7이 비슷한 내용을 검사하고, AC-3 자체는 직접 요청으로 확인했다. TASK-01 E2E는 QA가 새 스펙에 맞춰 갱신할 수 있다.
- 이번에는 UI-01 E2E를 돌리지 않았다.
- 스펙에 없는 기본 동작: 등록되지 않은 경로는 404와 `{"error":"Not Found"}`, 처리 중 예외가 나면 500을 돌려준다.

