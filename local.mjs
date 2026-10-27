#!/usr/bin/env node
// Local runner: the same Worker code on Node, with node:sqlite standing in for D1.
//   node local.mjs serve [port]   dashboard on 127.0.0.1 only
//   node local.mjs sync [--full]  one sync now
//   node local.mjs hook           Claude Code UserPromptSubmit hook (syncs once per local day)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import cfg from './config.json' with { type: 'json' };
import { report } from './src/model.js';
import { sync } from './src/sync.js';
import worker from './src/worker.js';

const root = import.meta.dirname;

// Minimal D1-compatible surface over node:sqlite (prepare/bind/first/all/run/batch).
export function d1(file) {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => raw.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(raw.prepare(sql).run(...args).changes) } }),
    exec: () => raw.prepare(sql).run(...args),
  });
  return {
    raw,
    prepare: sql => stmt(sql),
    batch: async stmts => {
      raw.exec('BEGIN');
      try { stmts.forEach(s => s.exec()); raw.exec('COMMIT'); } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
}

export function openDb(file = process.env.TICKETS_DB || path.join(root, '.data', 'tickets.db')) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = d1(file);
  for (const f of fs.readdirSync(path.join(root, 'migrations')).sort()) db.raw.exec(fs.readFileSync(path.join(root, 'migrations', f), 'utf8'));
  return db;
}

const githubToken = () => {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; }
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const assets = {
  fetch: async req => {
    const pub = path.join(root, 'public');
    const p = path.normalize(path.join(pub, new URL(req.url).pathname === '/' ? 'index.html' : new URL(req.url).pathname));
    if (!p.startsWith(pub + path.sep) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(p), { headers: { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' } });
  },
};

function serve(port = 8787) {
  const env = { DB: openDb(), ASSETS: assets, GITHUB_TOKEN: githubToken(), AXIOM_TOKEN: process.env.AXIOM_TOKEN, AXIOM_ORG_ID: process.env.AXIOM_ORG_ID, LOCAL_DEV: '1' };
  http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await worker.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  }).listen(port, '127.0.0.1', () => console.log(`Dashboard: http://127.0.0.1:${port}  (database: ${process.env.TICKETS_DB || '.data/tickets.db'})`));
}

const RETRY_AFTER_FAILURE_MS = 30 * 60e3;

async function hook() {
  const emit = text => text && process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }));
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const today = midnight.toISOString();
  if (process.env.TICKETS_URL) {
    // Deployed mode: ask the Worker (behind Cloudflare Access) to sync unless it already succeeded today.
    try {
      const res = await fetch(`${process.env.TICKETS_URL}/api/sync?trigger=claude-hook&ifNoSuccessSince=${encodeURIComponent(today)}`, {
        method: 'POST', headers: { 'cf-access-client-id': process.env.CF_ACCESS_CLIENT_ID ?? '', 'cf-access-client-secret': process.env.CF_ACCESS_CLIENT_SECRET ?? '' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return emit((await res.json()).summary);
    } catch (e) {
      return emit(`Daily ticket sync FAILED: deployed dashboard unreachable (${e.message}). Ticket data was not refreshed today.`);
    }
  }
  const db = openDb();
  if (await db.prepare("SELECT 1 FROM syncs WHERE status='success' AND started_at >= ?").bind(today).first()) return;
  const last = await db.prepare('SELECT * FROM syncs ORDER BY id DESC LIMIT 1').first();
  if (last && last.started_at >= today && Date.parse(last.started_at) > Date.now() - RETRY_AFTER_FAILURE_MS) {
    const ok = await db.prepare("SELECT started_at FROM syncs WHERE status='success' ORDER BY id DESC LIMIT 1").first();
    return emit(`Daily ticket sync not yet successful today: last attempt #${last.id} at ${last.started_at} was ${last.status} (${last.errors ?? ''}). Retrying after 30 minutes. Last successful sync: ${ok?.started_at ?? 'never'} — ticket data may be stale.`);
  }
  const r = await sync(db, cfg, { token: githubToken(), trigger: 'claude-hook' });
  emit(`${await report(db, cfg, r)}\nDashboard: run \`npm start\` in ${root} and open http://127.0.0.1:8787\nBriefly summarize this ticket status for the user, then continue with their request.`);
}

const [cmd, arg] = import.meta.main ? process.argv.slice(2) : [];
if (cmd === 'serve') serve(Number(arg) || 8787);
else if (cmd === 'sync') {
  const r = await sync(openDb(), cfg, { token: githubToken(), trigger: 'cli', full: arg === '--full' });
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.status === 'success' ? 0 : 1;
} else if (cmd === 'hook') await hook().catch(e => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `Daily ticket sync crashed: ${e.message}` } })));
else if (cmd) { console.error('usage: node local.mjs serve [port] | sync [--full] | hook'); process.exitCode = 2; }
