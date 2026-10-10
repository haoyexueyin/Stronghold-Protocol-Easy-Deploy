// SakuraFrp API v4 + the official frpc. Credentials remain in memory, never in arguments or config files.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { resolve4 } from 'node:dns/promises';
import { ROOT } from '../server/http/config.js';

const API = 'https://api.natfrp.com/v4';
const CACHE = path.join(ROOT, '.cache', 'sakurafrp');
const NOTE = 'Stronghold Protocol HTTPS launcher';
const CREATE = 1 << 2, PRIVATE = 1 << 6, AUTH = 1 << 8, OFFLINE = 1 << 9, BETA = 1 << 10;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = (ms, signal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
export const redact = (text, token) => token ? String(text).split(token).join('[密钥已隐藏]') : String(text);

export class SakuraApi {
  constructor(token, fetchImpl = fetch, signal) {
    if (!token || /[\r\n]/.test(token)) throw new Error('请在启动窗口输入有效的樱花访问密钥。');
    this.token = token;
    this.fetch = fetchImpl;
    this.signal = signal;
  }
  async request(route, body) {
    try {
      const r = await this.fetch(`${API}${route}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: timeout(15000, this.signal),
        headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const json = await r.json();
      if (!r.ok || (json?.msg && Number(json.code) >= 400)) throw new Error(json?.msg || `HTTP ${r.status}`);
      return json;
    } catch (e) {
      throw new Error(`樱花请求失败：${redact(e.message, this.token)}`);
    }
  }
}

function hostOf(node) {
  const host = String(node?.host || '');
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith('-')) throw new Error('樱花返回了无效的节点地址。');
  return host;
}
function remotePort(tunnel) {
  const raw = String(tunnel?.remote || '');
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('樱花未返回有效的远程端口。');
  return port;
}
function autoHttpsOff(extra) {
  // Reuse only plain TCP settings; arbitrary extras could enable plugins or override the local destination.
  const lines = String(extra || '').split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
  return lines.every((v) => /^auto_https\s*=\s*(?:""|'')?$/.test(v));
}
export function usableNode(node, creating = false) {
  if (!node || Number(node.vip) !== 0 || !Number.isInteger(node.flag)) return false;
  if (node.flag & (PRIVATE | AUTH | OFFLINE | BETA)) return false;
  return !creating || !!(node.flag & CREATE);
}
export function compatibleTunnel(t, nodes, port) {
  return t.type === 'tcp' && Number(t.status) === 0 && ['127.0.0.1', 'localhost'].includes(t.local_ip)
    && Number(t.local_port) === port && autoHttpsOff(t.extra) && usableNode(nodes[t.node]);
}
export async function readAccount(api) {
  const [user, nodes, tunnels] = await Promise.all([api.request('/user/info'), api.request('/nodes'), api.request('/tunnels')]);
  if (!Number.isInteger(user?.id) || !nodes || Array.isArray(nodes) || !Array.isArray(tunnels)) {
    throw new Error('樱花账户状态异常，请检查密钥、账户限制或实名认证状态。');
  }
  return { user, nodes, tunnels };
}
export async function prepareTunnel(api, account, port) {
  const { user, nodes, tunnels } = account;
  const name = `StrongholdHttps-${port}`;
  // Prefer our named tunnel; other offline TCP tunnels with the same settings can be reused without editing them.
  const compatible = tunnels.filter((t) => compatibleTunnel(t, nodes, port) && !t.online);
  compatible.sort((a, b) => Number(b.note === NOTE) - Number(a.note === NOTE) || Number(a.id) - Number(b.id));
  if (compatible.length) return { tunnel: compatible[0], node: nodes[compatible[0].node], created: false };
  if (tunnels.some((t) => t.note === NOTE && t.online && compatibleTunnel(t, nodes, port))) {
    throw new Error('本脚本的同端口隧道已在线，请先停止维持它的樱花客户端或旧启动窗口，再重新运行。');
  }
  if (Number.isInteger(user.tunnels) && tunnels.length >= user.tunnels) throw new Error('樱花隧道额度已满。请在面板腾出额度，或准备本地 127.0.0.1、相同端口且关闭自动 HTTPS 的免费节点 TCP 隧道。');
  const candidates = Object.entries(nodes).filter(([, n]) => usableNode(n, true));
  candidates.sort((a, b) => Number(a[0]) - Number(b[0]));
  if (!candidates.length) throw new Error('当前没有可创建的免费节点（可能满载、离线或要求访问认证）。请稍后重试。');
  const [id, node] = candidates[0];
  hostOf(node);
  let created;
  try {
    api.signal?.throwIfAborted();
    created = await api.request('/tunnels', { name, type: 'tcp', node: Number(id), local_ip: '127.0.0.1', local_port: port, note: NOTE, extra: '' });
  } catch (e) {
    // A timed-out POST may already have succeeded. Reconcile once; never retry a create blindly.
    const current = await api.request('/tunnels').catch(() => []);
    const recovered = Array.isArray(current) && current.find((t) => t.name === name && t.note === NOTE && !t.online && compatibleTunnel(t, nodes, port));
    if (!recovered) throw e;
    return { tunnel: recovered, node: nodes[recovered.node], created: true };
  }
  if (!Number.isInteger(created?.id)) throw new Error('樱花创建结果缺少隧道 ID。请在面板查看后重试。');
  // Read the actual assigned port and settings instead of assuming the create response contains a port.
  const current = await api.request('/tunnels');
  const tunnel = Array.isArray(current) && current.find((t) => t.id === created.id);
  if (!tunnel || tunnel.online || !compatibleTunnel(tunnel, nodes, port)) throw new Error('隧道已创建，但配置尚未就绪、不兼容或已由其他客户端启动，请在樱花面板检查后重试。');
  return { tunnel, node: nodes[tunnel.node], created: true };
}

function officialDownload(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.username || u.password || !['globalslb.net', 'natfrp.com'].some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`))) {
    throw new Error('下载地址不是支持的樱花官方 HTTPS 地址，请从樱花面板下载官方 frpc。');
  }
  return u;
}
export async function ensureFrpc(signal) {
  if (process.platform !== 'win32') throw new Error('此一键入口目前适用于 Windows。');
  const arch = { x64: 'amd64', ia32: '386', arm64: 'arm64' }[process.arch];
  if (!arch) throw new Error('当前 Windows 架构暂不支持一键下载 frpc。');
  const r = await fetch(`${API}/system/clients?download=true`, { redirect: 'error', signal: timeout(15000, signal) });
  if (!r.ok) throw new Error('无法获取樱花官方客户端下载信息。');
  const meta = (await r.json()).frpc;
  const version = String(meta?.ver || '');
  const asset = meta?.archs?.[`windows_${arch}`];
  if (!/^[\w.-]+$/.test(version) || !version.includes('sakura') || !asset?.url) throw new Error('樱花未提供兼容的 Windows 官方 frpc。');
  const file = path.join(CACHE, `frpc-windows-${arch}-${version}.exe`);
  fs.mkdirSync(CACHE, { recursive: true });
  if (!fs.existsSync(file)) {
    console.log(`[樱花] 首次下载官方 frpc ${version}，约 ${Math.ceil(Number(asset.size || 0) / 1024 / 1024)} MB…`);
    let url = officialDownload(asset.url);
    let download;
    for (let redirects = 0; redirects <= 4; redirects++) {
      download = await fetch(url, { redirect: 'manual', signal: timeout(120000, signal) });
      if (![301, 302, 303, 307, 308].includes(download.status)) break;
      await download.body?.cancel();
      url = officialDownload(new URL(download.headers.get('location') || '', url).href);
    }
    if (!download?.ok || !download.body) throw new Error('官方 frpc 下载失败，请重试。');
    const tempDir = path.join(ROOT, 'temp', 'sakurafrp');
    fs.mkdirSync(tempDir, { recursive: true });
    const temporary = path.join(tempDir, `frpc-${randomUUID()}.download`);
    let bytes = 0;
    const limit = new Transform({ transform(chunk, encoding, cb) {
      bytes += chunk.length;
      cb(bytes > 50 * 1024 * 1024 ? new Error('frpc 下载超过预期大小。') : null, chunk);
    } });
    try {
      await pipeline(Readable.fromWeb(download.body), limit, fs.createWriteStream(temporary, { flags: 'wx' }));
      if (!bytes || (Number(asset.size) > 0 && bytes !== Number(asset.size))) throw new Error('frpc 下载未完成，请重试。');
      fs.renameSync(temporary, file);
    } finally { try { fs.unlinkSync(temporary); } catch { /* absent */ } }
  }
  const versionCheck = spawnSync(file, ['-V'], { cwd: CACHE, encoding: 'utf8', timeout: 5000, windowsHide: true, env: { ...process.env, NATFRP_TOKEN: '', NATFRP_TARGET: '' } });
  if (versionCheck.status !== 0 || !String(versionCheck.stdout).includes('sakura')) throw new Error('缓存客户端无法运行或不是樱花官方版本，请删除 .cache/sakurafrp 中对应 exe 后重试。');
  return file;
}

export async function startSakura({ token, port, signal, api = new SakuraApi(token, fetch, signal), getFrpc = ensureFrpc, spawnImpl = spawn, waitMs = 30000 }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('樱花映射需要有效的本地端口。');
  await readAccount(api); // Validate the key before downloading, without retaining this potentially stale snapshot.
  signal?.throwIfAborted();
  const file = await getFrpc(signal); // Download before creating: a download failure must not consume a tunnel slot.
  signal?.throwIfAborted();
  const account = await readAccount(api); // A different client may have started a tunnel during the download.
  const { tunnel, node, created } = await prepareTunnel(api, account, port);
  signal?.throwIfAborted();
  const url = `https://${hostOf(node)}:${remotePort(tunnel)}`;
  console.log(`[樱花] ${created ? '已创建' : '复用'} TCP 隧道 ${tunnel.id} · 免费节点 ${node.name}`);
  const share = async () => {
    console.log(`\n[樱花] 公网访问地址：${url}`);
    // Ignore private/fake-IP answers; the official node hostname remains the primary address.
    const ips = await Promise.race([resolve4(hostOf(node)).catch(() => []), delay(2000).then(() => [])]);
    const ip = ips.find((v) => !/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|198\.(18|19)\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(v));
    if (ip) console.log(`[樱花] 公网 IP 地址：https://${ip}:${remotePort(tunnel)}`);
    console.log('[樱花] 将完整 https:// 地址发给朋友；Ctrl+C 停止本次映射。自签名证书会有浏览器提示。\n');
  };
  fs.mkdirSync(CACHE, { recursive: true });
  const child = spawnImpl(file, ['-n', '--disable_log_color', '--watch', String(process.pid)], { cwd: CACHE, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NATFRP_TOKEN: token, NATFRP_TARGET: String(tunnel.id) } });
  let ended = false;
  let ready = false;
  let resolveExit;
  const exit = new Promise((resolve) => { resolveExit = resolve; });
  const stop = () => { if (!ended) child.kill(); };
  const clean = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); signal?.removeEventListener('abort', stop); };
  child.once('error', () => { ended = true; clean(); resolveExit(1); });
  child.once('exit', (code) => { ended = true; clean(); resolveExit(code ?? 1); });
  // Buffer complete lines so a token split across chunks is still redacted.
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (data) => {
      pending += data;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).trimEnd();
        // The child's own success signal is required: API online may refer to a different computer.
        // Chinese format: doc.natfrp.com/bestpractice/domain-bind.html; English format is present in official frpc.
        if (/(?:^|\s)TCP 隧道启动成功$|\]\s*(?:start proxy success|隧道启动成功)$/.test(line)) ready = true;
        console.log(`[frpc] ${redact(line, token)}`);
        pending = pending.slice(newline + 1);
      }
      if (pending.length > 65536) pending = '[过长日志已省略]';
    });
    stream.on('end', () => { if (pending) console.log(`[frpc] ${redact(pending, token)}`); });
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    signal?.throwIfAborted();
    const until = Date.now() + waitMs;
    while (!ended && Date.now() < until) {
      const current = await api.request('/tunnels');
      signal?.throwIfAborted();
      if (ended) break;
      if (ready && Array.isArray(current) && current.some((t) => t.id === tunnel.id && t.online && Number(t.status) === 0)) {
        await share();
        return { url, stop, exit };
      }
      await Promise.race([delay(Math.min(2000, Math.max(1, until - Date.now()))), exit]);
    }
    throw new Error(ended ? 'frpc 已退出，请查看上方脱敏后的连接错误。' : '隧道尚未连接成功，请检查账户流量、节点或网络后重试。');
  } catch (e) { stop(); throw new Error(redact(e.message, token)); }
}
