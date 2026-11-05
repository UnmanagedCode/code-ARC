// Runs child commands to completion with deadlines, shared by the venv
// bootstrap and the bundle export. Each child gets its own process group; a
// timeout or stopAll() kills the whole group.
import { spawn as nodeSpawn } from 'node:child_process';

const TAIL_CHARS = 4000;

// Keeps the last `max` characters of a stream as a list of chunks.
export function createTail(max = TAIL_CHARS) {
  const chunks = [];
  let size = 0;
  return {
    push(s) {
      chunks.push(s);
      size += s.length;
      while (size - chunks[0].length >= max) size -= chunks.shift().length;
    },
    text: () => chunks.join('').slice(-max),
  };
}

export function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

// `run(cmd, args, opts)` resolves {code, timedOut?, error?, tail, stdout?};
// it never rejects. Options:
//   timeoutMs  kill the group after this long
//   stream     log each output line with `logPrefix`
//   cwd, env   for the child (env defaults to the parent's)
//   input      written to stdin, which is then closed (stdin is ignored without it)
//   stdoutMax  capture stdout separately into `stdout` (bytes); past it the child is killed
// After stopAll() no new child starts: run resolves {code:null, error} at once.
export function createRunner({ spawn = nodeSpawn, log = console, logPrefix = '', cwd: defaultCwd } = {}) {
  const children = new Set();
  let stopped = false;

  function run(cmd, args, { timeoutMs, stream = false, cwd = defaultCwd, env, input, stdoutMax } = {}) {
    return new Promise((resolve) => {
      const tail = createTail();
      if (stopped) {
        resolve({ code: null, error: new Error('stopped'), tail: '' });
        return;
      }
      let child;
      const stdin = input === undefined ? 'ignore' : 'pipe';
      try {
        child = spawn(cmd, args, { cwd, ...(env ? { env } : {}), detached: true, stdio: [stdin, 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ code: null, error: e, tail: '' });
        return;
      }
      children.add(child);
      let timedOut = false;
      let overflow = false;
      const out = [];
      let outSize = 0;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child);
      }, timeoutMs);
      timer.unref?.();
      const onData = (d) => {
        const s = d.toString();
        tail.push(s);
        if (stream) for (const line of s.split('\n')) if (line) log.log(`${logPrefix}${line}`);
      };
      if (stdoutMax !== undefined) {
        child.stdout?.on('data', (d) => {
          outSize += d.length;
          if (outSize > stdoutMax) {
            if (!overflow) {
              overflow = true;
              killGroup(child);
            }
            return;
          }
          out.push(Buffer.from(d));
        });
      } else {
        child.stdout?.on('data', onData);
      }
      child.stderr?.on('data', onData);
      if (input !== undefined && child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      }
      const done = (extra) => {
        clearTimeout(timer);
        children.delete(child);
        const r = { ...extra, tail: tail.text() };
        if (stdoutMax !== undefined) {
          r.stdout = Buffer.concat(out).toString('utf8');
          if (overflow) r.overflow = true;
        }
        resolve(r);
      };
      child.on('error', (e) => done({ code: null, error: e }));
      child.on('close', (code) => done({ code, timedOut }));
    });
  }

  return {
    run,
    stopAll() {
      stopped = true;
      for (const child of children) killGroup(child);
    },
  };
}
