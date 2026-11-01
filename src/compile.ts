import { access, mkdir, readFile, realpath, mkdtemp } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, delimiter, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { stateDir } from './session.js';
import { saveArtifact } from './artifacts.js';
import { archivePath, extractProject } from './zip.js';
import type { OverleafClient } from './client.js';
import { safeErrorMessage } from './errors.js';

export type CompileOptions = { projectId: string; mode: 'remote' | 'local' | 'auto'; rootPath?: string; compiler?: 'pdflatex' | 'xelatex' | 'lualatex'; timeoutSeconds?: number; signal?: AbortSignal };

async function executable(name: string) {
  for (const dir of [...(process.env.PATH ?? '').split(delimiter), '/Library/TeX/texbin', '/usr/local/bin', '/usr/bin']) {
    const path = join(dir, name);
    try { await access(path, constants.X_OK); return await realpath(path); } catch {}
  }
  return undefined;
}

function localCompileArguments(engine: string, rootPath: string, outputDir: string) {
  const mode = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' }[engine];
  if (!mode) throw new Error('Unsupported local compiler');
  return ['-norc', mode, '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', `-outdir=${outputDir}`, `./${rootPath}`];
}

async function run(command: string, args: string[], cwd: string, timeout: number, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; output: string }>((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const capture = (chunk: Buffer) => { if (output.length < 2 * 1024 * 1024) output += chunk.toString(); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const stop = () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (exitCode, signal) => { cleanup(); resolveResult({ exitCode, signal, timedOut, output }); });
  });
}

export async function compileLocal(client: OverleafClient, options: CompileOptions) {
  options.signal?.throwIfAborted();
  const project = await client.getProject(options.projectId);
  const rootPath = options.rootPath ?? project.files.find(file => file.id === project.rootDocId)?.path;
  if (!rootPath) throw new Error('Main document not found; provide rootPath');
  const compiler = options.compiler ?? project.compiler ?? 'pdflatex';
  const latexmk = await executable('latexmk');
  const engine = await executable(compiler);
  if (!latexmk || !engine) return { mode: 'local', status: 'missing-environment', compiler, error: `Local ${!latexmk ? 'latexmk' : compiler} was not found` };
  const source = await client.downloadProject(options.projectId);
  options.signal?.throwIfAborted();
  const workRoot = resolve(stateDir, 'builds');
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const workdir = await mkdtemp(join(workRoot, 'compile-'));
  const projectDir = join(workdir, 'source'), outputDir = join(workdir, 'output');
  await extractProject(source.artifact.localPath, projectDir);
  options.signal?.throwIfAborted();
  await access(archivePath(projectDir, rootPath));
  await mkdir(outputDir, { mode: 0o700 });
  await mkdir(join(workdir, 'tmp'), { mode: 0o700 });
  let command = latexmk;
  let args = localCompileArguments(compiler, rootPath, outputDir);
  let isolation = 'process';
  const sandbox = process.platform === 'darwin' ? await executable('sandbox-exec') : undefined;
  if (sandbox) {
    const quoted = JSON.stringify(await realpath(workdir));
    const texRoot = JSON.stringify(dirname(dirname(dirname(engine))));
    const profile = `(version 1)(deny default)(allow process*)(allow signal (target self))(allow sysctl-read)(allow mach-lookup)
      (allow file-read* (literal "/") (subpath "/System") (subpath "/Library") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/private/etc") (subpath "/private/var/db") (subpath "/dev") (subpath ${quoted}) (subpath ${texRoot}))
      (allow file-read-metadata)(allow file-write* (subpath ${quoted}) (literal "/dev/null"))`;
    command = sandbox; args = ['-p', profile, latexmk, ...args]; isolation = 'macos-sandbox';
  }
  const result = await run(command, args, projectDir, (options.timeoutSeconds ?? 120) * 1000, {
    LANG: process.env.LANG ?? 'en_US.UTF-8', PATH: [dirname(engine), dirname(latexmk), '/usr/bin', '/bin'].join(delimiter), TMPDIR: join(workdir, 'tmp'),
    TEXMFHOME: join(workdir, 'texmf'), TEXMFVAR: join(workdir, 'texmf-var'), TEXMFCONFIG: join(workdir, 'texmf-config'),
    openin_any: 'p', openout_any: 'p', shell_escape: 'f',
  }, options.signal);
  const stem = rootPath.split('/').at(-1)!.replace(/\.[^.]+$/, '');
  const outputs = [await saveArtifact('compiler-console.txt', Buffer.from(result.output), 'text/plain')];
  for (const ext of ['pdf', 'log', 'bbl', 'blg']) {
    try {
      const bytes = await readFile(join(outputDir, `${stem}.${ext}`));
      if (ext === 'pdf' && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) continue;
      outputs.push(await saveArtifact(`${stem}.${ext}`, bytes, ext === 'pdf' ? 'application/pdf' : 'text/plain'));
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  return { projectId: options.projectId, mode: 'local', status: options.signal?.aborted ? 'canceled' : result.timedOut ? 'timedout' : result.exitCode === 0 && outputs.some(file => file.mimeType === 'application/pdf') ? 'success' : 'compile-error',
    compiler, rootPath, isolation, exitCode: result.exitCode, signal: result.signal, sourceArchive: source.artifact, outputs, completedAt: new Date().toISOString() };
}

export async function compileProject(client: OverleafClient, options: CompileOptions) {
  options.signal?.throwIfAborted();
  if (options.mode === 'local') return compileLocal(client, options);
  let remote;
  try { remote = await client.compileRemote(options.projectId, options.rootPath, options.compiler, options.timeoutSeconds); }
  catch (error: any) {
    if (options.mode !== 'auto' || !/HTTP (429|5\d\d)|timeout|timed out|NetworkError|Failed to fetch/i.test(error.message)) throw error;
    remote = { mode: 'remote', status: 'service-unavailable', error: safeErrorMessage(error) };
  }
  if (options.mode !== 'auto' || !['timedout', 'timeout', 'service-unavailable'].includes(remote.status)) return remote;
  options.signal?.throwIfAborted();
  return { ...await compileLocal(client, options), fallbackFrom: remote };
}
