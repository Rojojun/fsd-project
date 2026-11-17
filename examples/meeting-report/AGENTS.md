# 회의 보고 시스템

fsd로 개발하는 대상 프로젝트다. 요구사항은 `requirements/`, 확정된 스펙은 `specs/`, 디자인은 `designs/`에 있다.

## 구조와 도구

- Node.js 내장 모듈만으로 만든다. 실행에 필요한 패키지를 추가하지 않는다.
- 서버는 `node:http`로 만든다. 진입점은 `app/server.mjs`다.
  - `createServer(options)`를 내보낸다. 호출하면 아직 listen하지 않은 `http.Server`를 돌려준다.
  - `options.tasks`로 처음 데이터를 넣어 줄 수 있다. 생략하면 비어 있다.
  - 파일을 직접 실행하면(`npm start`) 환경 변수 `PORT`(기본 3000)에서 listen한다.
- 데이터는 서버 프로세스의 메모리에 둔다.
- 화면이 있으면 `web/`에 두고 같은 서버가 내준다. 빌드 단계 없이 브라우저가 바로 읽는 HTML, CSS, JavaScript로 쓴다.

## E2E 테스트

- 모든 E2E는 Playwright Test로 쓴다. 파일은 `e2e/<요구사항 ID>/*.spec.mjs`.
- 테스트마다 `createServer()`로 서버를 직접 만들어 빈 포트(`listen(0)`)에 띄우고, 끝나면 닫는다. 미리 떠 있는 서버에 기대지 않는다.
- API는 Playwright의 `request`로 실제 HTTP 요청을 보내 검사한다.
- 화면은 Playwright의 `page`로 실제 브라우저에서 열어 검사한다. 브라우저는 설정(`playwright.config.mjs`)대로 설치된 Chrome을 쓴다.
- 실행: `npx playwright test e2e/<요구사항 ID>/`
