#!/usr/bin/env node
/**
 * Runs a klapz-server worktree and/or a klapz-web worktree locally, on ports of their own,
 * beside the main checkout's server (32500) and web app (5180).
 *
 *   node scripts/run-worktrees.mjs start --server <dir> --web <dir> [options]
 *   node scripts/run-worktrees.mjs status
 *   node scripts/run-worktrees.mjs stop [--name <name>]
 *
 * Ports are allocated once per instance name and kept in ~/.klapz-dev/instances.json, so a
 * worktree gets the same ports every time: the web app keeps the server it was given (it
 * lives in the origin's localStorage) and a bookmark keeps working. A port in use by
 * something else is never taken; a stale one is replaced by the next free one.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(os.homedir(), '.klapz-dev');
const REGISTRY = path.join(HOME, 'instances.json');
const HOST = '127.0.0.1';
const SERVER_PORTS = { first: 32510, last: 32599 };
const WEB_PORTS = { first: 5181, last: 5279 };
// The main checkout's server and web app, Plex's own port, Vite's preview.
const RESERVED = new Set([32400, 32500, 5180, 4173]);
const WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------- arguments

function parseArgs(argv) {
  const [command = 'start', ...rest] = argv;
  const options = { command };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (['release', 'reset-db', 'skip-build', 'help'].includes(key)) options[key] = true;
    else options[key] = rest[++i];
  }
  return options;
}

function usage() {
  console.log(`Usage:
  node scripts/run-worktrees.mjs start [--server <dir>] [--web <dir>] [options]
  node scripts/run-worktrees.mjs status
  node scripts/run-worktrees.mjs stop [--name <name>]

start options:
  --name <name>        Instance name; ports are kept per name (default: the server worktree's
                       folder name, else the web worktree's).
  --db copy|shared|fresh
                       copy   (default) a copy of the main database, made on first start
                       shared the main database itself: the branch's migrations will run on it
                       fresh  an empty database
  --reset-db           Copy the main database again (with --db copy).
  --env <file>         The .env to start from (default: the main checkout's, found through git).
  --server-url <url>   With --web alone: the server the web app should be pointed at
                       (default: http://127.0.0.1:32500, the main one).
  --release            Build and run the server in release mode.
  --skip-build         Run the server binary already built.`);
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------- registry

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  } catch {
    return { instances: {} };
  }
}

function writeRegistry(registry) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`);
}

// ---------------------------------------------------------------------------- ports

function canBind(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (error) => resolve(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT'));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

/** Free on every address a local server or Vite may use: IPv4 and IPv6 loopback, and all. */
async function isFree(port) {
  for (const host of ['127.0.0.1', '::1', '0.0.0.0']) {
    if (!(await canBind(port, host))) return false;
  }
  return true;
}

/** The port this instance had if it is still free, else the first free one no other instance owns. */
async function allocate(kind, range, name, registry) {
  const current = registry.instances[name]?.[kind];
  if (current && (await isFree(current))) return current;
  const taken = new Set(
    Object.entries(registry.instances)
      .filter(([other]) => other !== name)
      .map(([, instance]) => instance[kind]),
  );
  for (let port = range.first; port <= range.last; port++) {
    if (RESERVED.has(port) || taken.has(port)) continue;
    if (await isFree(port)) {
      if (current) console.log(`[ports] ${kind} port ${current} is in use by something else: moving to ${port}`);
      return port;
    }
  }
  return fail(`no free ${kind} port between ${range.first} and ${range.last}`);
}

// ---------------------------------------------------------------------------- processes

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function killTree(pid) {
  if (!isAlive(pid)) return;
  if (WINDOWS) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      process.kill(pid, 'SIGTERM');
    }
  }
}

/** Runs `command`, its output prefixed on this console and copied to `logFile`. */
function launch(label, command, args, { cwd, env, logFile }) {
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  log.write(`\n--- ${new Date().toISOString()} ${command} ${args.join(' ')}\n`);
  const child = spawn(command, args, { cwd, env, detached: !WINDOWS, stdio: ['ignore', 'pipe', 'pipe'] });
  const forward = (stream, out) => {
    let pending = '';
    stream.on('data', (chunk) => {
      log.write(chunk);
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) out.write(`[${label}] ${line}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  return child;
}

function run(command, args, cwd, label) {
  console.log(`[${label}] ${command} ${args.join(' ')}`);
  // npm is a .cmd on Windows, which only a shell runs.
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: WINDOWS && command === 'npm' });
  if (result.status !== 0) fail(`${label}: ${command} ${args.join(' ')} failed`);
}

async function waitFor(url, seconds, child) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    const answered = await new Promise((resolve) => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve(true);
      });
      request.on('error', () => resolve(false));
      request.setTimeout(2000, () => request.destroy());
    });
    if (answered) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

// ---------------------------------------------------------------------------- server set-up

/** The checkout a worktree belongs to: its `.git` directory's parent. */
function mainCheckout(worktree) {
  try {
    const common = execFileSync('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
    }).trim();
    return path.dirname(common);
  } catch {
    return null;
  }
}

function readEnvFile(file) {
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

/** The file an SQLite URL names, or null for another backend. */
function sqliteFile(url, base) {
  const match = /^sqlite:(?:\/\/)?([^?]+)/.exec(url ?? '');
  if (!match) return null;
  return path.resolve(base, match[1]);
}

function sqliteUrl(file) {
  return `sqlite://${file.replaceAll('\\', '/')}?mode=rwc`;
}

function prepareDatabase(mode, inherited, instanceDir, base, resetDb) {
  const mainUrl = inherited.KLAPZ_DATABASE_URL ?? 'sqlite://klapz.db?mode=rwc';
  const mainFile = sqliteFile(mainUrl, base);
  const images = inherited.KLAPZ_IMAGES_DIR ?? (mainFile ? path.join(path.dirname(mainFile), 'images') : undefined);
  if (mode === 'shared') {
    console.log(`[db] shared with the main checkout: ${mainUrl} (this branch's migrations will run on it)`);
    return { url: mainUrl, images };
  }
  const file = path.join(instanceDir, 'klapz.db');
  if (mode === 'fresh') {
    if (resetDb || !fs.existsSync(file)) {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
      console.log(`[db] fresh database: ${file}`);
    }
    return { url: sqliteUrl(file), images };
  }
  if (mode !== 'copy') fail(`--db must be copy, shared or fresh, not ${mode}`);
  if (!mainFile) fail(`--db copy needs an SQLite main database, not ${mainUrl}: use --db shared or fresh`);
  if (resetDb || !fs.existsSync(file)) {
    if (!fs.existsSync(mainFile)) fail(`no main database at ${mainFile}`);
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(file + suffix, { force: true });
      if (fs.existsSync(mainFile + suffix)) fs.copyFileSync(mainFile + suffix, file + suffix);
    }
    console.log(`[db] copied ${mainFile} to ${file}`);
  } else {
    console.log(`[db] reusing this instance's copy: ${file} (--reset-db to copy again)`);
  }
  return { url: sqliteUrl(file), images };
}

// ---------------------------------------------------------------------------- commands

async function start(options) {
  const server = options.server && path.resolve(options.server);
  const web = options.web && path.resolve(options.web);
  if (!server && !web) fail('give --server <dir>, --web <dir> or both');
  if (server && !fs.existsSync(path.join(server, 'crates', 'server'))) fail(`${server} is not a klapz-server checkout`);
  if (web && !fs.existsSync(path.join(web, 'vite.config.js'))) fail(`${web} is not a klapz-web checkout`);
  const name = options.name ?? path.basename(server ?? web);

  const registry = readRegistry();
  const previous = registry.instances[name];
  const running = [previous?.serverPid, previous?.webPid].filter(isAlive);
  if (running.length) fail(`"${name}" is already running (pid ${running.join(', ')}): stop it first with "stop --name ${name}"`);

  const serverPort = await allocate('serverPort', SERVER_PORTS, name, registry);
  const webPort = await allocate('webPort', WEB_PORTS, name, registry);
  const instanceDir = path.join(HOME, name);
  fs.mkdirSync(instanceDir, { recursive: true });
  registry.instances[name] = { ...previous, serverPort, webPort, server: server ?? null, web: web ?? null };
  writeRegistry(registry);

  const children = [];
  const stopAll = () => {
    for (const child of children) killTree(child.pid);
    const latest = readRegistry();
    if (latest.instances[name]) {
      delete latest.instances[name].serverPid;
      delete latest.instances[name].webPid;
      writeRegistry(latest);
    }
  };
  // `stop` forgets a pid before killing it: a child gone that way was asked to go.
  const leave = (label, child, key, code) => {
    const asked = readRegistry().instances[name]?.[key] !== child.pid;
    console.log(asked ? `[${label}] stopped` : `[${label}] exited with ${code}`);
    stopAll();
    process.exit(asked ? 0 : (code || 1));
  };
  process.on('SIGINT', () => {
    console.log('\nstopping…');
    stopAll();
    process.exit(0);
  });

  let serverUrl = options['server-url'] ?? 'http://127.0.0.1:32500';
  if (server) {
    const checkout = mainCheckout(server);
    const envFile = options.env ?? (checkout && path.join(checkout, '.env'));
    const inherited = envFile && fs.existsSync(envFile) ? readEnvFile(envFile) : {};
    console.log(envFile && fs.existsSync(envFile) ? `[env] from ${envFile}` : '[env] no .env found: server defaults');
    const database = prepareDatabase(options.db ?? 'copy', inherited, instanceDir, checkout ?? server, options['reset-db']);

    const profile = options.release ? 'release' : 'debug';
    if (!options['skip-build']) {
      run('cargo', ['build', ...(options.release ? ['--release'] : []), '-p', 'klapz-server', '-p', 'klapz-scanner'], server, 'build');
    }
    const binary = path.join(server, 'target', profile, `klapz-server${WINDOWS ? '.exe' : ''}`);
    if (!fs.existsSync(binary)) fail(`no server binary at ${binary}`);

    const env = {
      ...process.env,
      ...inherited,
      KLAPZ_BIND: `${HOST}:${serverPort}`,
      KLAPZ_DATABASE_URL: database.url,
      // One tray icon is the main server's; another would open the wrong web app.
      KLAPZ_TRAY: '0',
    };
    if (database.images) env.KLAPZ_IMAGES_DIR = database.images;
    if (web) {
      const origin = `http://${HOST}:${webPort}`;
      env.KLAPZ_CORS_ORIGINS = [inherited.KLAPZ_CORS_ORIGINS, origin, `http://localhost:${webPort}`].filter(Boolean).join(',');
    }
    const child = launch('server', binary, [], { cwd: server, env, logFile: path.join(instanceDir, 'server.log') });
    children.push(child);
    serverUrl = `http://${HOST}:${serverPort}`;
    const latest = readRegistry();
    latest.instances[name].serverPid = child.pid;
    writeRegistry(latest);
    child.on('exit', (code) => leave('server', child, 'serverPid', code));
    if (!(await waitFor(`${serverUrl}/identity`, 120, child))) {
      stopAll();
      fail(`the server did not answer on ${serverUrl}: see ${path.join(instanceDir, 'server.log')}`);
    }
  }

  if (web) {
    if (!fs.existsSync(path.join(web, 'node_modules', 'vite'))) run('npm', ['ci'], web, 'web');
    const vite = path.join(web, 'node_modules', 'vite', 'bin', 'vite.js');
    // --port and --strictPort win over the config's 5180: Vite fails rather than drift to
    // another port, which would leave the registry wrong.
    const child = launch('web', process.execPath, [vite, '--host', HOST, '--port', String(webPort), '--strictPort'], {
      cwd: web,
      env: process.env,
      logFile: path.join(instanceDir, 'web.log'),
    });
    children.push(child);
    const latest = readRegistry();
    latest.instances[name].webPid = child.pid;
    writeRegistry(latest);
    child.on('exit', (code) => leave('web', child, 'webPid', code));
    if (!(await waitFor(`http://${HOST}:${webPort}/`, 60, child))) {
      stopAll();
      fail(`the web app did not answer on port ${webPort}: see ${path.join(instanceDir, 'web.log')}`);
    }
  }

  console.log(`
==================================================================
 klapz "${name}" is running
${server ? ` server   ${serverUrl}   (database: ${options.db ?? 'copy'})\n` : ''}${
    web ? ` web      http://${HOST}:${webPort}/\n          on /connect, give the server: ${serverUrl.replace(/^http:\/\//, '')}\n` : ''
  } sign in as admin, with KLAPZ_ADMIN_PASSWORD from the .env
 logs     ${instanceDir}
 stop     Ctrl-C, or: node scripts/run-worktrees.mjs stop --name ${name}
==================================================================
`);
}

function status() {
  const { instances } = readRegistry();
  const names = Object.keys(instances);
  if (!names.length) {
    console.log('no instance yet');
    return;
  }
  for (const name of names) {
    const instance = instances[name];
    const state = (pid) => (isAlive(pid) ? `running (pid ${pid})` : 'stopped');
    console.log(`${name}
  server  http://${HOST}:${instance.serverPort}  ${instance.server ? state(instance.serverPid) : 'not run'}  ${instance.server ?? ''}
  web     http://${HOST}:${instance.webPort}  ${instance.web ? state(instance.webPid) : 'not run'}  ${instance.web ?? ''}`);
  }
}

function stop(options) {
  const registry = readRegistry();
  const names = options.name ? [options.name] : Object.keys(registry.instances);
  for (const name of names) {
    const instance = registry.instances[name];
    if (!instance) fail(`no instance named "${name}"`);
    const pids = [instance.serverPid, instance.webPid].filter(isAlive);
    delete instance.serverPid;
    delete instance.webPid;
    writeRegistry(registry);
    for (const pid of pids) killTree(pid);
    console.log(pids.length ? `stopped "${name}"` : `"${name}" was not running`);
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) usage();
else if (options.command === 'start') await start(options);
else if (options.command === 'status') status();
else if (options.command === 'stop') stop(options);
else {
  usage();
  process.exit(1);
}
