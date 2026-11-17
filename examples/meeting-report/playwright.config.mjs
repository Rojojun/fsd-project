import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // 테스트마다 서버를 따로 띄우므로 서로 영향을 주지 않는다.
  fullyParallel: true,
  reporter: 'list',
  // 이 컴퓨터에 설치된 Chrome을 쓴다. 브라우저를 따로 내려받지 않는다.
  use: { channel: 'chrome', screenshot: 'only-on-failure' },
  outputDir: '.playwright',
});
