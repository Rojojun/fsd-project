import { execProcess } from './exec.ts';
import type { Exec } from './types.ts';

/**
 * 어떤 외부 도구(디자인 도구, 이슈 관리 도구)가 지금 쓸 수 있게 연결되어 있는지 확인한다.
 * 도구가 있으면 쓰고 없으면 다른 길로 가기 위해서다. 실행할 때마다 확인하므로, 연결하면 설정을 바꾸지 않아도 쓰이기 시작한다.
 */

/** `<에이전트> mcp list` 출력에서 지금 쓸 수 있는 서버 이름만 뽑는다. */
export const connectedServers = (agent: string, output: string): string[] => {
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
  if (agent === 'claude') {
    // "이름: 주소 - ✔ Connected". 인증이 필요하거나 연결에 실패한 서버는 제외한다.
    return lines.flatMap(l => /^(.+?): .* - ✔ Connected$/.exec(l)?.[1] ?? []);
  }
  // codex: 칸이 공백으로 나뉜 표. 켜져 있고 로그인된 서버만.
  return lines
    .filter(l => /\benabled\b/.test(l) && !/Not logged in/.test(l))
    .map(l => l.split(/\s+/)[0]);
};

export type Listed = readonly Readonly<{ agent: string; servers: readonly string[] }>[];

/** 역할에 지정된 에이전트를 먼저, 그다음 claude를 본다. */
export const listServers = async (roleAgent: string, exec: Exec = execProcess): Promise<Listed> =>
  Promise.all(
    [...new Set([roleAgent, 'claude'])].map(async agent => {
      const run = await exec(agent, ['mcp', 'list'], { cwd: process.cwd(), timeoutMs: 60_000 });
      return { agent, servers: connectedServers(agent, run.stdout) };
    }),
  );

/** 이름에 keyword가 든 서버를, 앞에 있는 에이전트부터 찾는다. */
export const findServer = (listed: Listed, keyword: string): { agent: string; server: string } | null => {
  for (const { agent, servers } of listed) {
    const server = servers.find(name => name.toLowerCase().includes(keyword));
    if (server) return { agent, server };
  }
  return null;
};
