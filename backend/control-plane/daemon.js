#!/usr/bin/env node
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.BVPN_DATA_DIR || process.env.VPND_DATA_DIR || path.join(__dirname, '../../data');
const PROFILES_PATH = path.join(DATA_DIR, 'profiles.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const PROTO_SESSIONS_PATH = path.join(DATA_DIR, 'proto_sessions.json');
const PROTO_EVENTS_PATH = path.join(DATA_DIR, 'proto_events.ndjson');
const TUNNEL_LEASES_PATH = path.join(DATA_DIR, 'tunnel_leases.json');
const NOISE_PRIV_PATH = path.join(DATA_DIR, 'noise-static.key');
const NOISE_CFG_PATH = path.join(DATA_DIR, 'noise-config.json');

const TUN_CLIENT_BIN = process.env.BVPN_TUN_CLIENT_BIN || '/usr/local/bin/blockchain-vpn-tun-client';
const TUN_NAME = process.env.BVPN_TUN_NAME || 'bvpntun1';
const TUN_MTU = Number(process.env.BVPN_TUN_MTU || 1380);
const ROUTE_DEFAULT = process.env.BVPN_ROUTE_DEFAULT !== 'false';

const HOST = process.env.BVPN_HOST || process.env.VPND_HOST || '0.0.0.0';
const PORT = Number(process.env.BVPN_PORT || process.env.VPND_PORT || 8787);
const TUNNEL_SUBNET = process.env.BVPN_TUN_SUBNET || '10.99.0.0/24';
const TUNNEL_GATEWAY = process.env.BVPN_TUN_GATEWAY || '10.99.0.1';
const TUNNEL_PREFIX = Number(process.env.BVPN_TUN_PREFIX || 24);
const TUNNEL_LEASE_START = Number(process.env.BVPN_TUN_LEASE_START || 2);
const TUNNEL_LEASE_END = Number(process.env.BVPN_TUN_LEASE_END || 254);
const TOKENS = (process.env.BVPN_TOKENS || process.env.BVPN_TOKEN || process.env.VPND_TOKENS || process.env.VPND_TOKEN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PROFILES_PATH)) fs.writeFileSync(PROFILES_PATH, '[]\n');
if (!fs.existsSync(STATE_PATH)) fs.writeFileSync(STATE_PATH, JSON.stringify({ connected: false }, null, 2));
if (!fs.existsSync(PROTO_SESSIONS_PATH)) fs.writeFileSync(PROTO_SESSIONS_PATH, '{}\n');
if (!fs.existsSync(PROTO_EVENTS_PATH)) fs.writeFileSync(PROTO_EVENTS_PATH, '');
if (!fs.existsSync(TUNNEL_LEASES_PATH)) fs.writeFileSync(TUNNEL_LEASES_PATH, '{}\n');

let active = null;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n'); }
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function nowIso() { return new Date().toISOString(); }

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function authorize(req) {
  if (TOKENS.length === 0) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return false;
  const provided = h.slice(7);
  return TOKENS.some((t) => {
    try { return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(t)); } catch { return false; }
  });
}

function isPidAlive(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function clearState(reason = 'manual') {
  writeJson(STATE_PATH, {
    connected: false,
    profileId: null,
    pid: null,
    clearedAt: nowIso(),
    clearReason: reason,
    updatedAt: nowIso(),
  });
}

function status() {
  const s = readJson(STATE_PATH, { connected: false });
  const pid = active?.pid || s.pid || null;
  const alive = isPidAlive(pid);
  const connected = !!s.connected && !!pid && alive;
  if (s.connected && !connected) clearState('stale-status-reconcile');
  return {
    connected,
    profileId: connected ? (active?.profileId || s.profileId || null) : null,
    pid: connected ? pid : null,
    startedAt: connected ? (s.startedAt || null) : null,
    updatedAt: nowIso(),
  };
}

function startProfile(profile) {
  if (!profile.command || !Array.isArray(profile.args)) throw new Error('Profile must include command and args[]');
  const child = spawn(profile.command, profile.args, {
    cwd: profile.cwd || process.cwd(),
    env: { ...process.env, ...(profile.env || {}) },
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.on('error', (err) => {
    active = null;
    writeJson(STATE_PATH, {
      connected: false, profileId: null, pid: null,
      lastExit: { code: null, signal: null, at: nowIso(), profileId: profile.id, error: err.message },
      updatedAt: nowIso(),
    });
  });

  child.stdout.on('data', (d) => process.stdout.write(`[vpn:${profile.id}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[vpn:${profile.id}] ${d}`));

  active = { pid: child.pid || null, profileId: profile.id, process: child, startedAt: nowIso() };
  writeJson(STATE_PATH, {
    connected: true,
    profileId: profile.id,
    pid: child.pid,
    startedAt: active.startedAt,
    updatedAt: nowIso(),
  });

  child.on('exit', (code, signal) => {
    const prev = active;
    active = null;
    writeJson(STATE_PATH, {
      connected: false,
      profileId: null,
      pid: null,
      lastExit: { code, signal, at: nowIso(), profileId: prev?.profileId || null },
      updatedAt: nowIso(),
    });
  });

  return active;
}

function stopActive() {
  if (active?.process) { active.process.kill('SIGTERM'); return true; }
  const s = readJson(STATE_PATH, { connected: false });
  if (s.pid && isPidAlive(s.pid)) {
    try { process.kill(Number(s.pid), 'SIGTERM'); return true; } catch { return false; }
  }
  if (s.connected) clearState('disconnect-no-active-process');
  return false;
}

function readSessions() { return readJson(PROTO_SESSIONS_PATH, {}); }
function writeSessions(obj) { writeJson(PROTO_SESSIONS_PATH, obj); }
function readTunnelLeases() { return readJson(TUNNEL_LEASES_PATH, {}); }
function writeTunnelLeases(obj) { writeJson(TUNNEL_LEASES_PATH, obj); }
function appendEvent(evt) {
  fs.appendFileSync(PROTO_EVENTS_PATH, JSON.stringify(evt) + '\n');
}
function readRecentEvents(limit = 100) {
  const text = fs.readFileSync(PROTO_EVENTS_PATH, 'utf8');
  const lines = text.trim() ? text.trim().split('\n') : [];
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function protoMetrics() {
  const sessions = readSessions();
  const events = readRecentEvents(5000);
  const now = Date.now();
  const activeSessions = Object.values(sessions).filter((s) => now - Date.parse(s.lastSeenAt || s.updatedAt || 0) < 60_000).length;
  const events24h = events.filter((e) => now - Date.parse(e.ts || 0) < 24 * 60 * 60 * 1000).length;
  let totalRx = 0, totalTx = 0, totalKeepalive = 0;
  for (const s of Object.values(sessions)) {
    totalRx += Number(s.rxBytes || 0);
    totalTx += Number(s.txBytes || 0);
    totalKeepalive += Number(s.keepaliveCount || 0);
  }
  return {
    sessionCount: Object.keys(sessions).length,
    activeSessions,
    totalKeepalive,
    totalRxBytes: totalRx,
    totalTxBytes: totalTx,
    events24h,
    generatedAt: nowIso(),
  };
}

function leaseIpHostPart(ip) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip || '');
  if (!m) return null;
  return Number(m[4]);
}

function tunnelLeaseState() {
  return {
    subnet: TUNNEL_SUBNET,
    gateway: TUNNEL_GATEWAY,
    prefix: TUNNEL_PREFIX,
    rangeStart: TUNNEL_LEASE_START,
    rangeEnd: TUNNEL_LEASE_END,
  };
}

function normalizeClientId(value) {
  const v = String(value || '').trim();
  return v || null;
}

function normalizeRequestedIp(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(v) ? v : null;
}

function allocateTunnelLease(body = {}) {
  const leases = readTunnelLeases();
  const clientId = normalizeClientId(body.clientId) || `c_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const requestedIp = normalizeRequestedIp(body.requestedIp);
  const now = nowIso();

  if (leases[clientId]?.ip) {
    const existing = leases[clientId];
    existing.updatedAt = now;
    existing.lastSeenAt = now;
    existing.platform = body.platform || existing.platform || null;
    existing.deviceName = body.deviceName || existing.deviceName || null;
    writeTunnelLeases(leases);
    return {
      ok: true,
      clientId,
      lease: {
        ip: existing.ip,
        cidr: `${existing.ip}/${TUNNEL_PREFIX}`,
        gateway: TUNNEL_GATEWAY,
      },
      state: tunnelLeaseState(),
    };
  }

  const used = new Set(Object.values(leases).map((v) => v?.ip).filter(Boolean));
  let allocatedIp = null;
  if (requestedIp) {
    const host = leaseIpHostPart(requestedIp);
    if (host !== null && host >= TUNNEL_LEASE_START && host <= TUNNEL_LEASE_END && !used.has(requestedIp) && requestedIp !== TUNNEL_GATEWAY) {
      allocatedIp = requestedIp;
    }
  }
  if (!allocatedIp) {
    const prefixParts = TUNNEL_GATEWAY.split('.');
    if (prefixParts.length !== 4) throw new Error(`Invalid BVPN_TUN_GATEWAY: ${TUNNEL_GATEWAY}`);
    const base = `${prefixParts[0]}.${prefixParts[1]}.${prefixParts[2]}.`;
    for (let i = TUNNEL_LEASE_START; i <= TUNNEL_LEASE_END; i++) {
      const candidate = `${base}${i}`;
      if (candidate === TUNNEL_GATEWAY || used.has(candidate)) continue;
      allocatedIp = candidate;
      break;
    }
  }
  if (!allocatedIp) throw new Error('No tunnel IP leases available');

  leases[clientId] = {
    clientId,
    ip: allocatedIp,
    platform: body.platform || null,
    deviceName: body.deviceName || null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
  writeTunnelLeases(leases);
  return {
    ok: true,
    clientId,
    lease: {
      ip: allocatedIp,
      cidr: `${allocatedIp}/${TUNNEL_PREFIX}`,
      gateway: TUNNEL_GATEWAY,
    },
    state: tunnelLeaseState(),
  };
}

// ----------------------------------------------------------------
// Noise IK pairing — derives a static X25519 keypair from a wallet
// personal_sign signature of the canonical "Noise identity derivation"
// message. The signature is deterministic per wallet (RFC 6979), so
// the same wallet always derives the same X25519 key — and the same
// key was independently re-derived server-side when the user bound
// their noise_public_key via the webui.
// ----------------------------------------------------------------
function pkcs8WrapX25519(raw32) {
  if (raw32.length !== 32) throw new Error('X25519 private key must be 32 bytes');
  const prefix = Buffer.from([
    0x30, 0x2e,
    0x02, 0x01, 0x00,
    0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
    0x04, 0x22,
    0x04, 0x20,
  ]);
  return Buffer.concat([prefix, raw32]);
}

function deriveX25519FromSignature(sigHex) {
  const sig = Buffer.from(String(sigHex || '').replace(/^0x/i, ''), 'hex');
  if (sig.length < 65) throw new Error('signature must be at least 65 bytes');

  const seed = crypto.hkdfSync(
    'sha256',
    sig,
    Buffer.from('blockchain-vpn-noise-v1'),
    Buffer.alloc(0),
    32
  );
  const privBuf = Buffer.from(seed);

  const privObj = crypto.createPrivateKey({
    key: pkcs8WrapX25519(privBuf),
    format: 'der',
    type: 'pkcs8',
  });
  const pubDer = crypto.createPublicKey(privObj).export({ format: 'der', type: 'spki' });
  const pubBuf = pubDer.slice(pubDer.length - 32);
  return { priv: privBuf, pub: pubBuf };
}

function readNoiseConfig() {
  return readJson(NOISE_CFG_PATH, null);
}

function writeNoiseConfig(obj) {
  writeJson(NOISE_CFG_PATH, obj);
}

function noiseStatus() {
  const cfg = readNoiseConfig();
  const hasKey = fs.existsSync(NOISE_PRIV_PATH);
  return {
    bound: Boolean(cfg && hasKey),
    walletAddress: cfg?.walletAddress || null,
    clientPublicKey: cfg?.clientPublicKey || null,
    serverPublicKey: cfg?.serverPublicKey || null,
    tunnelHost: cfg?.tunnelHost || null,
    tunnelPort: cfg?.tunnelPort || null,
    boundAt: cfg?.boundAt || null,
  };
}

function bindNoise(body) {
  const { signature, walletAddress, serverPublicKey, tunnelHost, tunnelPort } = body || {};
  if (!signature) throw new Error('signature required');
  if (!serverPublicKey || !/^[0-9a-f]{64}$/i.test(serverPublicKey)) {
    throw new Error('serverPublicKey must be 64 hex chars');
  }
  if (!tunnelHost) throw new Error('tunnelHost required');
  if (!tunnelPort) throw new Error('tunnelPort required');

  const { priv, pub } = deriveX25519FromSignature(signature);
  fs.writeFileSync(NOISE_PRIV_PATH, priv, { mode: 0o600 });
  const cfg = {
    walletAddress: walletAddress || null,
    clientPublicKey: pub.toString('hex'),
    serverPublicKey: String(serverPublicKey).toLowerCase(),
    tunnelHost: String(tunnelHost),
    tunnelPort: Number(tunnelPort),
    boundAt: nowIso(),
  };
  writeNoiseConfig(cfg);
  return { ok: true, ...noiseStatus() };
}

function unbindNoise() {
  try { fs.unlinkSync(NOISE_PRIV_PATH); } catch {}
  try { fs.unlinkSync(NOISE_CFG_PATH); } catch {}
  return { ok: true, ...noiseStatus() };
}

function buildTunClientProfile() {
  const cfg = readNoiseConfig();
  if (!cfg) throw new Error('Noise client not paired — POST to /v1/noise/bind first');
  if (!fs.existsSync(NOISE_PRIV_PATH)) throw new Error('Noise private key file missing');

  // Allocate a tunnel IP for this device using the noise pubkey as the
  // clientId so reconnects reuse the same lease.
  const clientId = `noise:${cfg.clientPublicKey.slice(0, 16)}`;
  const lease = allocateTunnelLease({ clientId, platform: 'linux', deviceName: 'tauri-desktop' });
  const tunCidr = lease.lease.cidr;

  return {
    id: 'noise-default',
    name: 'noise-default',
    command: TUN_CLIENT_BIN,
    args: [
      '--tun', TUN_NAME,
      '--tun-cidr', tunCidr,
      '--server', `${cfg.tunnelHost}:${cfg.tunnelPort}`,
      '--mtu', String(TUN_MTU),
      '--noise-key', NOISE_PRIV_PATH,
      '--server-pubkey', cfg.serverPublicKey,
      '--route-default=' + (ROUTE_DEFAULT ? 'true' : 'false'),
    ],
    cwd: process.cwd(),
    env: {},
    createdAt: nowIso(),
  };
}

function releaseTunnelLease(body = {}) {
  const clientId = normalizeClientId(body.clientId);
  if (!clientId) return { ok: false, removed: false };
  const leases = readTunnelLeases();
  if (!leases[clientId]) return { ok: true, removed: false };
  delete leases[clientId];
  writeTunnelLeases(leases);
  return { ok: true, removed: true };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // CORS — the Tauri desktop client lives at tauri://localhost and needs to
  // call this loopback daemon. Reflect any origin since we already gate by
  // bind address (127.0.0.1) and optional BVPN_TOKEN.
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] || 'Authorization,Content-Type'
    );
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, ts: nowIso() });
  if (!authorize(req)) return send(res, 401, { error: 'Unauthorized' });

  try {
    if (req.method === 'GET' && url.pathname === '/v1/status') return send(res, 200, status());

    if (req.method === 'GET' && url.pathname === '/v1/tunnel/leases') {
      return send(res, 200, { leases: readTunnelLeases(), state: tunnelLeaseState() });
    }

    if (req.method === 'POST' && url.pathname === '/v1/tunnel/lease') {
      const body = await parseBody(req);
      return send(res, 200, allocateTunnelLease(body));
    }

    if (req.method === 'POST' && url.pathname === '/v1/tunnel/release') {
      const body = await parseBody(req);
      return send(res, 200, releaseTunnelLease(body));
    }

    if (req.method === 'GET' && url.pathname === '/v1/profiles') {
      return send(res, 200, { profiles: readJson(PROFILES_PATH, []) });
    }

    if (req.method === 'POST' && url.pathname === '/v1/profiles') {
      const body = await parseBody(req);
      if (!body?.name || !body?.command || !Array.isArray(body?.args)) return send(res, 400, { error: 'name, command, args[] required' });
      const profiles = readJson(PROFILES_PATH, []);
      const id = body.id || `p_${Date.now()}`;
      const profile = {
        id, name: body.name, command: body.command, args: body.args,
        cwd: body.cwd || process.cwd(), env: body.env || {}, createdAt: nowIso(),
      };
      profiles.push(profile);
      writeJson(PROFILES_PATH, profiles);
      return send(res, 201, { profile });
    }

    if (req.method === 'GET' && url.pathname === '/v1/noise/status') {
      return send(res, 200, noiseStatus());
    }

    if (req.method === 'POST' && url.pathname === '/v1/noise/bind') {
      const body = await parseBody(req);
      return send(res, 200, bindNoise(body));
    }

    if (req.method === 'POST' && url.pathname === '/v1/noise/unbind') {
      return send(res, 200, unbindNoise());
    }

    if (req.method === 'POST' && url.pathname === '/v1/connect') {
      const st = status();
      if (active || st.connected) return send(res, 409, { error: 'Already connected', state: st });

      // Noise-paired devices ignore the profile selector and use the
      // bound static key. Falls back to a legacy profile only if no
      // Noise binding exists.
      const body = await parseBody(req);
      let profile;
      if (readNoiseConfig()) {
        profile = buildTunClientProfile();
      } else {
        const profiles = readJson(PROFILES_PATH, []);
        profile = profiles.find((p) => p.id === body.profileId);
        if (!profile) return send(res, 404, { error: 'Profile not found and Noise client not paired' });
      }
      const a = startProfile(profile);
      return send(res, 200, { ok: true, connected: true, profileId: a.profileId, pid: a.pid });
    }

    if (req.method === 'POST' && url.pathname === '/v1/disconnect') {
      const stopped = stopActive();
      return send(res, 200, { ok: true, stopping: stopped });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/v1/profiles/')) {
      const id = url.pathname.split('/').pop();
      const profiles = readJson(PROFILES_PATH, []);
      const next = profiles.filter((p) => p.id !== id);
      writeJson(PROFILES_PATH, next);
      return send(res, 200, { ok: true, removed: profiles.length - next.length });
    }

    // --- protocol monitoring endpoints for backend integration ---
    if (req.method === 'POST' && url.pathname === '/v1/proto/keepalive') {
      const body = await parseBody(req);
      const sessionId = body.sessionId || body.peerId;
      if (!sessionId) return send(res, 400, { error: 'sessionId required' });
      const sessions = readSessions();
      const prev = sessions[sessionId] || { sessionId, createdAt: nowIso(), keepaliveCount: 0, rxBytes: 0, txBytes: 0 };
      const next = {
        ...prev,
        clientId: body.clientId || prev.clientId || null,
        profileId: body.profileId || prev.profileId || null,
        state: body.state || prev.state || 'active',
        rttMs: Number.isFinite(Number(body.rttMs)) ? Number(body.rttMs) : (prev.rttMs ?? null),
        rxBytes: Number(prev.rxBytes || 0) + Math.max(0, Number(body.rxBytes || 0)),
        txBytes: Number(prev.txBytes || 0) + Math.max(0, Number(body.txBytes || 0)),
        keepaliveCount: Number(prev.keepaliveCount || 0) + 1,
        lastSeenAt: nowIso(),
        updatedAt: nowIso(),
        meta: body.meta || prev.meta || {},
      };
      sessions[sessionId] = next;
      writeSessions(sessions);
      appendEvent({ ts: nowIso(), level: 'info', type: 'keepalive', sessionId, rttMs: next.rttMs });
      return send(res, 200, { ok: true, session: next });
    }

    if (req.method === 'POST' && url.pathname === '/v1/proto/events') {
      const body = await parseBody(req);
      if (!body.event) return send(res, 400, { error: 'event required' });
      const evt = {
        ts: nowIso(),
        level: body.level || 'info',
        event: body.event,
        sessionId: body.sessionId || null,
        clientId: body.clientId || null,
        details: body.details || {},
      };
      appendEvent(evt);
      return send(res, 201, { ok: true, event: evt });
    }

    if (req.method === 'GET' && url.pathname === '/v1/proto/sessions') {
      const sessions = readSessions();
      return send(res, 200, { sessions: Object.values(sessions) });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/proto/sessions/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const sessions = readSessions();
      const s = sessions[id];
      if (!s) return send(res, 404, { error: 'Session not found' });
      return send(res, 200, { session: s });
    }

    if (req.method === 'GET' && url.pathname === '/v1/proto/events') {
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 100)));
      return send(res, 200, { events: readRecentEvents(limit) });
    }

    if (req.method === 'GET' && url.pathname === '/v1/proto/metrics') {
      return send(res, 200, protoMetrics());
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    return send(res, 500, { error: err.message || 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`blockchain-vpn api listening on http://${HOST}:${PORT}`);
  if (TOKENS.length === 0) console.warn('WARNING: BVPN_TOKEN(S) empty. API is unauthenticated.');
});
