import { spawn } from 'node:child_process';
import type { Exec } from './types.ts';

/** 프로세스를 실행하고 시간 한도를 넘기면 종료시킨다. 입력은 닫아 둔다(대화형 대기 방지). */
export const execProcess: Exec = (command, args, { cwd, timeoutMs }) =>
  new Promise(resolve => {
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    const finish = (code: number | null, extra = '') => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') + extra, timedOut });
    };
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', e => finish(null, e.message));
    child.on('close', code => finish(code));
  });
