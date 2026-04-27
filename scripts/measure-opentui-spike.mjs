#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const py = String.raw`
import os, pty, select, subprocess, termios, time, fcntl, struct, signal, sys, re

runs = int(os.environ.get('RUNS', '5'))
cmd = [
  'pi', '--offline', '--model', 'google/gemini-2.5-flash',
  '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
  '--no-context-files', '--no-session', '-e', './src/opentui-spike-extension.ts'
]
pattern = re.compile(rb'SUMOCODE|cathedral shell island')
results = []
for i in range(runs):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 160, 0, 0))
    env = os.environ.copy()
    env['ANTHROPIC_API_KEY'] = ''
    env['ANTHROPIC_OAUTH_TOKEN'] = ''
    env['PI_OFFLINE'] = '1'
    start = time.perf_counter()
    proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, env=env, cwd=os.getcwd(), close_fds=True)
    os.close(slave)
    buf = b''
    first = None
    deadline = start + 10
    try:
        while time.perf_counter() < deadline:
            r, _, _ = select.select([master], [], [], 0.05)
            if not r:
                continue
            chunk = os.read(master, 8192)
            if not chunk:
                break
            buf += chunk
            if first is None and pattern.search(buf):
                first = time.perf_counter() - start
                break
    finally:
        try:
            os.write(master, b'\x04')
            time.sleep(0.15)
        except OSError:
            pass
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()
        os.close(master)
    if first is None:
        print(f'run {i+1}: timeout')
    else:
        ms = first * 1000
        results.append(ms)
        print(f'run {i+1}: {ms:.1f}ms')

if results:
    sorted_results = sorted(results)
    median = sorted_results[len(sorted_results)//2]
    p95_index = min(len(sorted_results)-1, int((len(sorted_results)-1)*0.95 + 0.999))
    p95 = sorted_results[p95_index]
    print(f'median: {median:.1f}ms')
    print(f'p95: {p95:.1f}ms')
`;

const result = spawnSync("python3", ["-c", py], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
