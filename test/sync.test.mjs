// Isolated tests: GitHub is mocked, the database is an in-memory node:sqlite instance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { d1 } from '../local.mjs';
import { enrich, LIST_COLUMNS, report, SHOWN } from '../src/model.js';
import { gql, sync } from '../src/sync.js';
import { authorized } from '../src/worker.js';
import fs from 'node:fs';
import baseCfg from '../config.json' with { type: 'json' };

const TOKEN = 'test-token-not-a-real-credential';
const cfg = { ...baseCfg, sources: [{ type: 'github', org: 'acme', author: 'me', exclude: [], kinds: ['issue'] }], sla: { clock: 'calendar', policies: [] }, fixEnvironments: undefined };

function freshDb() {
  const db = d1(':memory:');
  db.raw.exec(fs.readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  return db;
}

const issue = (n, over = {}) => ({
  id: `I_${n}`, number: n, title: `Issue ${n}`, body: 'b', url: `https://github.com/acme/a/issues/${n}`, state: 'OPEN', stateReason: null,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', closedAt: null, author: { login: 'me' },
  milestone: null, assignees: { nodes: [] }, labels: { nodes: [] }, comments: { totalCount: 0 }, issueType: null,
  blockedBy: { nodes: [] }, timelineItems: { totalCount: 0, nodes: [] }, ...over,
});

// Mock GitHub GraphQL: repos a + b, issues paged 50 at a time, honouring `since` and the author filter.
function github(store, { failRepo } = {}) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    assert.equal(init.headers.authorization, `bearer ${TOKEN}`);
    const { query, variables: v } = JSON.parse(init.body);
    calls.push(v);
    const ok = data => new Response(JSON.stringify({ data: { rateLimit: { remaining: 4000, resetAt: 'x' }, ...data } }), { status: 200 });
    if (query.includes('organization(')) return ok({ organization: { repositories: { pageInfo: { hasNextPage: false }, nodes: Object.keys(store).map(name => ({ name, isArchived: false, hasIssuesEnabled: true })) } } });
    if (v.name === failRepo) return new Response('bad', { status: 400 });
    assert.equal(v.author, 'me');
    const all = store[v.name].filter(i => i.author.login === v.author && (!v.since || i.updatedAt >= v.since)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const start = Number(v.after ?? 0), nodes = all.slice(start, start + 50);
    return ok({ repository: { issues: { pageInfo: { hasNextPage: start + 50 < all.length, endCursor: String(start + 50) }, nodes } } });
  };
  return { fetchImpl, calls };
}

const rows = async db => (await db.prepare(`SELECT ${LIST_COLUMNS} FROM tickets ORDER BY number`).all()).results.map(r => enrich(cfg, r));
const run = (db, gh, opts = {}) => sync(db, cfg, { token: TOKEN, fetchImpl: gh.fetchImpl, ...opts });

test('discovers every ticket across repos with pagination, ignores other authors, no duplicates on re-sync', async () => {
  const store = { a: Array.from({ length: 120 }, (_, i) => issue(i + 1)), b: [issue(500), issue(501, { author: { login: 'someone-else' } })] };
  const db = freshDb(), gh = github(store);
  const r1 = await run(db, gh);
  assert.equal(r1.status, 'success');
  assert.equal(r1.stats.fetched, 121);
  assert.equal(gh.calls.filter(c => c.name === 'a').length, 3, 'three pages for 120 issues');
  const r2 = await run(db, gh, { full: true });
  assert.equal(r2.stats.unchanged, 121);
  const { n, d } = await db.prepare('SELECT count(*) n, count(DISTINCT id) d FROM tickets').first();
  assert.equal(n, 121); assert.equal(d, 121);
});

test('new tickets, state/assignee/priority changes, close and reopen are recorded from snapshots', async () => {
  const store = { a: [issue(1), issue(2)] };
  const db = freshDb(), gh = github(store);
  await run(db, gh); // baseline: no change rows
  assert.equal((await db.prepare('SELECT count(*) n FROM changes').first()).n, 0);

  const later = new Date(Date.now() + 60e3).toISOString();
  store.a[0] = issue(1, { title: 'Issue 1 P0', updatedAt: later, assignees: { nodes: [{ login: 'asad' }] } });
  store.a[1] = issue(2, { state: 'CLOSED', stateReason: 'COMPLETED', closedAt: later, updatedAt: later, timelineItems: { totalCount: 1, nodes: [{ __typename: 'ClosedEvent', createdAt: later, actor: { login: 'me' }, stateReason: 'COMPLETED' }] } });
  store.a.push(issue(3, { createdAt: later, updatedAt: later }));
  const r = await run(db, gh);
  assert.equal(r.mode, 'incremental');
  const ch = (await db.prepare('SELECT t.number, c.field, c.old, c.new FROM changes c JOIN tickets t ON t.id = c.ticket_id ORDER BY c.id').all()).results.map(c => `${c.number}:${c.field}:${c.old}->${c.new}`);
  assert.ok(ch.includes('1:assignees:[]->["asad"]'), ch.join());
  assert.ok(ch.includes('1:priority:null->P0'), ch.join());
  assert.ok(ch.includes('2:state:OPEN->CLOSED'), ch.join());
  assert.ok(ch.includes('3:_new:null->created'), ch.join());
  let t = await rows(db);
  assert.equal(t[0].severity, 'critical');
  assert.equal(t[1].status, 'done');
  assert.ok(t[1].resolved_at);

  const later2 = new Date(Date.now() + 120e3).toISOString();
  store.a[1] = issue(2, { updatedAt: later2, timelineItems: { totalCount: 2, nodes: [...store.a[1].timelineItems.nodes, { __typename: 'ReopenedEvent', createdAt: later2, actor: { login: 'me' } }] } });
  await run(db, gh);
  t = await rows(db);
  assert.equal(t[1].state, 'OPEN');
  assert.equal(t[1].reopened, true);
  assert.equal(t[1].resolved_at, null);
  assert.equal((await db.prepare("SELECT count(*) n FROM snapshots WHERE ticket_id = 'github:I_2'").first()).n, 3);
  // Re-running with nothing new must not count the completion again.
  const r4 = await run(db, gh, { full: true });
  assert.equal(r4.stats.changed, 0);
});

test('partial failure is reported, keeps existing data, and does not advance the failed cursor or flag missing tickets', async () => {
  const store = { a: [issue(1)], b: [issue(2)] };
  const db = freshDb();
  await run(db, github(store));
  const cursor = scope => db.prepare('SELECT since FROM cursors WHERE scope = ?').bind(scope).first();
  const before = await cursor('github:acme/b:issue:by:me');
  await new Promise(r => setTimeout(r, 5));
  const r = await run(db, github(store, { failRepo: 'b' }), { full: true });
  assert.equal(r.status, 'partial');
  assert.deepEqual(await cursor('github:acme/b:issue:by:me'), before);
  assert.notDeepEqual(await cursor('github:acme/a:issue:by:me'), before);
  assert.match(r.errors[0].error, /HTTP 400/);
  assert.equal((await rows(db)).length, 2);
  assert.equal((await db.prepare('SELECT count(*) n FROM tickets WHERE missing_since IS NOT NULL').first()).n, 0);
});

test('a ticket absent from a complete full sweep is flagged missing, never deleted or closed', async () => {
  const store = { a: [issue(1), issue(2)] };
  const db = freshDb(), gh = github(store);
  await run(db, gh);
  store.a.pop();
  const inc = await run(db, gh); // incremental runs never flag
  assert.equal(inc.stats.missing, 0);
  const r = await run(db, gh, { full: true });
  assert.equal(r.stats.missing, 1);
  const t = (await rows(db))[1];
  assert.equal(t.state, 'OPEN');
  assert.ok(t.missing_since);
});

test('sync without a token fails loudly and records the failure', async () => {
  const db = freshDb();
  const r = await sync(db, cfg, { token: undefined, fetchImpl: () => assert.fail('must not call GitHub') });
  assert.equal(r.status, 'failed');
  assert.equal((await db.prepare('SELECT status FROM syncs').first()).status, 'failed');
});

test('gql retries network errors and stops on low rate limit', async () => {
  let n = 0;
  const flaky = async () => (++n === 1 ? Promise.reject(new TypeError('fetch failed')) : new Response(JSON.stringify({ data: { rateLimit: { remaining: 10, resetAt: 'soon' } } })));
  await assert.rejects(gql(TOKEN, '{}', {}, flaky), e => e.rateLimited === true);
  assert.equal(n, 2);
});

test('SLA: unconfigured policies never breach; configured policies compute response/resolution states', () => {
  const now = Date.parse('2026-10-10T00:00:00Z');
  const base = { id: 'x', repo: 'acme/a', number: 1, kind: 'issue', title: '[Security] P0 thing', state: 'OPEN', author: 'me', assignees: '[]', labels: '["Security"]', blocked_by: '[]', priority: 'P0', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', facts: '{}' };
  assert.equal(enrich(cfg, base, now).sla.state, 'not_configured');
  assert.equal(enrich(cfg, base, now).overdue, false);
  const withPolicy = { ...cfg, sla: { clock: 'calendar', policies: [{ id: 'sec-p0', match: { type: 'Security', priority: 'P0' }, responseHours: 4, resolutionHours: 240 }] } };
  const t = enrich(withPolicy, base, now);
  assert.equal(t.sla.response.state, 'breached');
  assert.equal(t.sla.resolution.state, 'ok');
  assert.equal(t.sla.state, 'breached');
  const closed = enrich(withPolicy, { ...base, state: 'CLOSED', state_reason: 'COMPLETED', closed_at: '2026-10-02T00:00:00Z', facts: JSON.stringify({ first_response_at: '2026-10-01T01:00:00Z' }) }, now);
  assert.equal(closed.sla.response.state, 'met');
  assert.equal(closed.sla.resolution.state, 'met');
  const atRisk = enrich(withPolicy, base, Date.parse('2026-10-10T23:00:00Z'));
  assert.equal(atRisk.sla.resolution.state, 'at_risk');
});

test('hook report summarises counts and never contains the token', async () => {
  const db = freshDb();
  const r = await run(db, github({ a: [issue(1, { title: 'P1 Blocked thing', labels: { nodes: [{ name: 'Blocked' }] } })] }));
  const text = await report(db, cfg, r);
  assert.match(text, /status SUCCESS/);
  assert.match(text, /blocked 1/);
  assert.match(text, /policy not configured/);
  assert.ok(!text.includes(TOKEN));
});

test('auth: Cloudflare Access JWT is verified; local bypass only on localhost', async () => {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
  const env = { ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'aud123' };
  const certs = async () => new Response(JSON.stringify({ keys: [jwk] }));
  const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const sign = async payload => {
    const head = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(payload)}`;
    return `${head}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(head))).toString('base64url')}`;
  };
  const req = jwt => new Request('https://tickets.example.com/api/tickets', { headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} });
  const good = { aud: ['aud123'], iss: env.ACCESS_TEAM_DOMAIN, exp: Date.now() / 1000 + 60 };
  assert.equal(await authorized(req(await sign(good)), env, certs), true);
  assert.equal(await authorized(req(), env, certs), false);
  assert.equal(await authorized(req(await sign({ ...good, aud: ['other'] })), env, certs), false);
  assert.equal(await authorized(req(await sign({ ...good, exp: 1 })), env, certs), false);
  const forged = (await sign(good)).replace(/\.[^.]+$/, '.' + b64('x'.repeat(256)));
  assert.equal(await authorized(req(forged), env, certs), false);
  assert.equal(await authorized(req(await sign(good)), {}, certs), false, 'unconfigured Access fails closed');
  assert.equal(await authorized(new Request('http://127.0.0.1:8787/'), { LOCAL_DEV: '1' }), true);
  assert.equal(await authorized(new Request('http://evil.example/'), { LOCAL_DEV: '1' }), false);
});

test('fixed-in: decided by code on each branch (cherry-picks, reverts, every change), never by comment text', async () => {
  let n = 0;
  const commit = (message, parents = 1) => ({ oid: `${(++n).toString(16).padStart(7, '0')}${'0'.repeat(33)}`, message, committedDate: `2026-10-${String(10 + n).padStart(2, '0')}T00:00:00Z`, parents: { totalCount: parents } });
  const c1 = commit('fix(x): guard input (a#1)\n\nlong body');
  const c2 = commit('fix(y): second part of the fix'); // no issue ref: only reachable through the comment link
  const unrelated = commit('fix(z): unrelated (a#2)');
  const branches = { development: [c1, c2, unrelated], staging: [], main: [] };
  const comment = body => ({ __typename: 'IssueComment', createdAt: '2026-10-02T00:00:00Z', author: { login: 'asad' }, body, url: 'u' });
  const store = { a: [
    issue(1, { body: 'Bug introduced in https://github.com/acme/svc/commit/deadbee', timelineItems: { totalCount: 1, nodes: [comment(`Fixed on development: https://github.com/acme/svc/commit/${c2.oid.slice(0, 8)}`)] } }),
    issue(2, { state: 'CLOSED', stateReason: 'NOT_PLANNED', closedAt: '2026-10-03T00:00:00Z' }),
  ] };
  const gh = github(store);
  const fetchImpl = async (url, init) => {
    const { query, variables: v } = JSON.parse(init.body);
    const ok = data => new Response(JSON.stringify({ data: { rateLimit: { remaining: 4000, resetAt: 'x' }, ...data } }));
    if (query.includes('history(')) {
      const list = branches[v.ref.replace('refs/heads/', '')];
      return ok({ repository: { ref: list ? { target: { history: { pageInfo: { hasNextPage: false }, nodes: [...list].reverse() } } } : null } });
    }
    if (query.includes('object(expression')) return ok({ repository: { object: Object.values(branches).flat().find(c => c.oid.startsWith(v.oid)) ?? null } });
    return gh.fetchImpl(url, init);
  };
  const fcfg = { ...cfg, fixEnvironments: { repos: ['acme/svc'], branches: [['main', 'production'], ['staging', 'staging'], ['development', 'dev']] } };
  const db = freshDb();
  const fix = async () => {
    const r = await sync(db, fcfg, { token: TOKEN, fetchImpl, full: true });
    assert.deepEqual(r.errors, []);
    return (await db.prepare(`SELECT ${LIST_COLUMNS} FROM tickets WHERE ${SHOWN}`).all()).results.map(r => enrich(fcfg, r));
  };

  let list = await fix();
  assert.deepEqual(list.map(t => t.number), [1], 'cancelled tickets are not shown');
  assert.equal(list[0].fix.env, 'dev');
  assert.deepEqual(list[0].fix.evidence.map(e => e.subject).sort(), ['fix(x): guard input (a#1)', 'fix(y): second part of the fix'], 'description links are not evidence');

  branches.main.push({ ...commit('fix(x): guard input (a#1) (#9)'), committedDate: '2026-10-20T00:00:00Z' }); // cherry-pick: new SHA, same change
  assert.equal((await fix())[0].fix.env, 'dev', 'one of two changes on main is not "fixed on production"');

  branches.main.push({ ...commit('fix(y): second part of the fix'), committedDate: '2026-10-21T00:00:00Z' });
  list = await fix();
  assert.equal(list[0].fix.env, 'production', 'code on main wins over the comment saying development');
  assert.deepEqual(list[0].fix.evidence.map(e => e.branches.staging), [false, false]);

  branches.main.push({ ...commit('Revert "fix(x): guard input (a#1)"\n\nThis reverts commit abc.'), committedDate: '2026-10-22T00:00:00Z' });
  assert.equal((await fix())[0].fix.env, 'dev', 'a revert on main takes production away');

  const history = (await db.prepare("SELECT old, new FROM changes WHERE field = 'fixed_in' ORDER BY id").all()).results.map(c => `${c.old}->${c.new}`);
  assert.deepEqual(history, ['dev->production', 'production->dev']);
  const text = await report(db, fcfg, { id: 99, status: 'success', mode: 'full', stats: { fetched: 0, new: 0, changed: 0 }, errors: [] });
  assert.match(text, /Open issues 1;/);
});
