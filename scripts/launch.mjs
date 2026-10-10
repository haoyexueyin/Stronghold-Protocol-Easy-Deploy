#!/usr/bin/env node
// scripts/launch.mjs — cross-platform "prepare + start + open the browser", used by scripts/start-windows.bat,
// scripts/start-windows.ps1 and scripts/start.sh (docs/DEPLOY.md).
//
//   node scripts/launch.mjs [--port 3000] [--host ::] [--no-open] [--no-setup] [setup options…]
//
//   1. If our server already answers on the port, just open the browser (double-clicking twice is harmless).
//   2. An update package extracted over the folder (UPDATE.json) is finished (server/update.js; the server does it too,
//      for the routes that skip this script); one that does not fit this install stops here with the message.
//   3. node tools/setup.mjs --quiet (dependencies, vendor libs, art download / resume, optional local extraction);
//      setup options such as --no-assets, --no-local, --local, --game <dir>, -y are passed through.
//   4. node server/index.js (PORT / HOST from the options or the environment; SP_COMBAT / SP_VERIFY / TRUST_PROXY /
//      DEBUG are inherited), then — once /healthz answers — prints the addresses to share and opens
//      http(s)://localhost:<port> (not with --no-open, SP_NO_BROWSER=1, or on a Linux box without a display).
// Ctrl+C stops the server (it gets the signal from the terminal itself); the exit code is the server's.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { httpsEnabled } from '../server/http/tls.js';
import { startSakura, redact } from './sakurafrp.mjs';
// 打开浏览器只有一份实现（走 shell 关联 = 默认浏览器，且不会把浏览器拉成提权）
import { openBrowser as openInBrowser } from './open-browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`Node.js ${process.versions.node} 太旧，需要 22 或更高（22 / 24 LTS）：https://nodejs.org/zh-cn/download`);
  process.exit(1);
}

const { c, mark } = await import('../tools/setup.mjs');
const { probePort, classifyAddresses, hostUrl, KIND_LABEL } = await import('../tools/doctor.mjs');
const { applyPendingUpdate, UPDATE_FILE } = await import('../server/update.js');

function parseArgs(argv) {
  const o = { port: Number(process.env.PORT) || 3000, host: process.env.HOST || '::', open: !/^(1|true|yes)$/i.test(process.env.SP_NO_BROWSER || ''), setup: true, setupArgs: [], help: false, sakura: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.split('=');
    const val = () => (v !== undefined ? v : argv[++i]);
    if (k === '--port') o.port = Number(val()) || o.port;
    else if (k === '--host') o.host = val() || o.host;
    else if (a === '--no-open') o.open = false;
    else if (a === '--no-setup') o.setup = false;
    else if (a === '--sakura') o.sakura = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--game') o.setupArgs.push(a, argv[++i] ?? '');
    else o.setupArgs.push(a);
  }
  return o;
}

function openBrowser(url) {
  return openInBrowser(url) !== null;
}

function printShare(port, protocol = 'http') {
  const addrs = classifyAddresses().filter((a) => a.kind === 'lan' || a.kind === 'vpn' || a.kind === 'public');
  const line = c.dim('─'.repeat(56));
  console.log(`\n${line}`);
  console.log(`${mark.ok} ${c.bold('服务器已启动')}   本机打开：${c.cyan(`${protocol}://localhost:${port}`)}`);
  if (addrs.length) {
    console.log('  发给朋友（需要能访问这台电脑的网络）：');
    for (const a of addrs.slice(0, 4)) console.log(`    ${c.cyan(hostUrl(a.address, port, protocol))}  ${c.dim(KIND_LABEL[a.kind])}`);
  } else {
    console.log(c.warn('  没有检测到可以分享的地址：朋友暂时无法连接（检查网线/Wi-Fi）。'));
  }
  console.log(c.dim('  建房后把 4 位「同盟密钥」或「复制链接」（…/?room=密钥）发给朋友。'));
  if (protocol === 'https') console.log(c.dim(`  樱花映射：TCP 隧道，本地 127.0.0.1:${port}，关闭「自动 HTTPS」；朋友访问 https://远程地址:远程端口。自签名证书会有浏览器提示。`));
  console.log(c.dim('  朋友打不开？运行 node tools/doctor.mjs 检查防火墙。按 Ctrl+C 停止服务器。'));
  console.log(`${line}\n`);
}

async function waitHealthy(port, child, protocol, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && child.exitCode === null) {
    const p = await probePort(port, '::', protocol);
    if (p.state === 'ours' && p.protocol === protocol) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function connectSakura(token, port, serverExit) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  serverExit?.then(cancel);
  try { return await startSakura({ token, port, signal: controller.signal }); }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const sakuraToken = o.sakura ? process.env.NATFRP_TOKEN?.trim() : null;
  if (o.sakura) delete process.env.NATFRP_TOKEN; // Only frpc needs the secret, never setup or the game server.
  if (o.help) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
    console.log(src.slice(1, 15).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  const protocol = httpsEnabled() ? 'https' : 'http';
  if (o.sakura && (protocol !== 'https' || !sakuraToken)) {
    console.error(`${mark.err} 樱花一键联机需要 HTTPS 和访问密钥，请双击 scripts\\start-sakura-windows.bat。`);
    return 1;
  }
  const localUrl = `${protocol}://localhost:${o.port}`;

  const before = await probePort(o.port, o.host, protocol);
  if (before.state === 'ours') {
    if (before.protocol !== protocol) {
      console.error(`${mark.err} 端口 ${o.port} 上正在运行 ${before.protocol.toUpperCase()}，本次需要 ${protocol.toUpperCase()}。请先关闭旧服务器窗口，再重新启动。`);
      return 1;
    }
    console.log(`${mark.ok} 服务器已经在运行（端口 ${o.port}），直接打开浏览器。`);
    if (protocol === 'https') console.log(c.dim('  已运行的服务器不会重新加载证书；若刚更换或续签证书，请先在旧窗口按 Ctrl+C 停止，再启动。'));
    if (fs.existsSync(path.join(ROOT, UPDATE_FILE))) {
      console.log(c.warn(`  解压过的更新包还没有应用：正在运行的仍是旧版本。先停止它（关掉它的窗口；开机自启用 install-service-windows.ps1 -Restart），再重新启动即可。`));
    }
    printShare(o.port, protocol);
    if (o.open) openBrowser(localUrl);
    if (o.sakura) {
      try {
        const tunnel = await connectSakura(sakuraToken, o.port);
        return await tunnel.exit;
      } catch (e) { console.error(`${mark.err} ${redact(e.message, sakuraToken)}`); return 1; }
    }
    return 0;
  }
  if (before.state !== 'free') {
    console.error(`${mark.err} 端口 ${o.port} 被其他程序占用或无权限（${before.code || before.state}）。`);
    console.error(`  换一个端口：${IS_WIN ? 'scripts\\start-windows.bat --port 3001' : 'scripts/start.sh --port 3001'}`);
    return 1;
  }

  // before setup: setup and the server then see the new version's files (its message explains a refusal)
  if (applyPendingUpdate(ROOT).state === 'failed') return 1;

  if (o.setup) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'setup.mjs'), '--quiet', ...o.setupArgs], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) { console.error(`${mark.err} 准备步骤失败（见上方）。`); return r.status || 1; }
  }

  const env = { ...process.env, PORT: String(o.port), HOST: o.host };
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: 'inherit' });
  const forward = (sig) => { if (child.exitCode === null) { try { child.kill(sig); } catch { /* gone */ } } };
  // SIGINT reaches the server straight from the terminal (same process group / console); forwarding it too would make
  // the server's second-signal path force-exit. Other signals (service managers, `kill`) are forwarded.
  process.on('SIGINT', () => {});
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGBREAK']) { try { process.on(sig, () => forward(sig === 'SIGBREAK' ? 'SIGTERM' : sig)); } catch { /* unsupported here */ } }

  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? (signal ? 0 : 1))));
  if (await waitHealthy(o.port, child, protocol)) {
    printShare(o.port, protocol);
    if (o.open && !openBrowser(localUrl)) console.log(c.dim(`（未能自动打开浏览器，请手动访问 ${localUrl}）`));
    if (o.sakura) {
      try {
        const tunnel = await connectSakura(sakuraToken, o.port, exited);
        exited.then(() => tunnel.stop());
        tunnel.exit.then((code) => { if (code) console.error(`${mark.err} 樱花映射已停止，本地游戏服务器仍在运行；请重启此窗口重新连接。`); });
      } catch (e) {
        console.error(`${mark.err} ${redact(e.message, sakuraToken)}`);
        console.log(c.dim('樱花映射未成功，本地游戏服务器仍可使用。请检查错误后重启此窗口。'));
      }
    }
  }
  return exited;
}

// Same convention as tools/setup.mjs: the helpers above are importable, but only running this file starts anything.
// Without the guard, importing launch.mjs would fall through to main() in the background and bind a port.
function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e?.stack || e); process.exitCode = 1; });
}
