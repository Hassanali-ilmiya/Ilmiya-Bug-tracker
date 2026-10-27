import cfg from '../config.json' with { type: 'json' };
import { enrich, LIST_COLUMNS, report, SHOWN, statusDurations } from './model.js';
import { sync } from './sync.js';

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const b64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

let certs;
// Cloudflare Access sits in front of the Worker; this re-verifies its JWT so a misconfigured route fails closed.
export async function authorized(req, env, fetchImpl = fetch) {
  const host = new URL(req.url).hostname;
  if (env.LOCAL_DEV === '1') return host === '127.0.0.1' || host === 'localhost';
  const token = req.headers.get('cf-access-jwt-assertion');
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  try {
    const [h, p, s] = token.split('.');
    const header = JSON.parse(new TextDecoder().decode(b64(h))), payload = JSON.parse(new TextDecoder().decode(b64(p)));
    if (!certs || Date.now() - certs.at > 3600e3) certs = { at: Date.now(), keys: (await (await fetchImpl(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`)).json()).keys };
    const jwk = certs.keys.find(k => k.kid === header.kid);
    if (!jwk || header.alg !== 'RS256') return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64(s), new TextEncoder().encode(`${h}.${p}`));
    return valid && [].concat(payload.aud).includes(env.ACCESS_AUD) && payload.iss === env.ACCESS_TEAM_DOMAIN && payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

const meta = async db => ({
  lastSync: await db.prepare('SELECT * FROM syncs ORDER BY id DESC LIMIT 1').first(),
  lastSuccess: await db.prepare("SELECT * FROM syncs WHERE status='success' ORDER BY id DESC LIMIT 1").first(),
});

// Telemetry: Axiom only. Query text mirrors the existing Axiom APM dashboards (server spans, OPTIONS excluded).
const IS_ERROR = "(column_ifexists('error', false) == true or column_ifexists('attributes.http.response.status_code', 0) >= 400)";
const IS_5XX = "(column_ifexists('error', false) == true or column_ifexists('attributes.http.response.status_code', 0) >= 500)";
const DUR = "totimespan(column_ifexists('duration', ''))";
const RANGES = { '1h': [1, '1m'], '24h': [24, '15m'], '7d': [168, '1h'], '30d': [720, '6h'] };

async function apl(env, apl, hours) {
  const end = new Date(), start = new Date(end - hours * 3600e3);
  const res = await fetch(`${cfg.telemetry.axiom.url}/v1/datasets/_apl?format=tabular`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.AXIOM_TOKEN}`, 'content-type': 'application/json', ...(env.AXIOM_ORG_ID && { 'x-axiom-org-id': env.AXIOM_ORG_ID }) },
    body: JSON.stringify({ apl, startTime: start.toISOString(), endTime: end.toISOString() }),
  });
  if (!res.ok) throw new Error(`Axiom HTTP ${res.status}`);
  const t = (await res.json()).tables[0];
  return t.columns[0]?.map((_, i) => Object.fromEntries(t.fields.map((f, j) => [f.name, t.columns[j][i]]))) ?? [];
}

async function health(env, url) {
  const off = reason => ({ connected: false, reason });
  const out = {
    newrelic: off('Not connected: no New Relic API key has been provided to this app. New Relic owns Kubernetes/infrastructure metrics; no data from it is shown here.'),
    cloudwatch: off('Not connected: no AWS credentials are available to this app. CloudWatch owns AWS-native telemetry; no data from it is shown here.'),
    slos: cfg.slos,
  };
  if (!env.AXIOM_TOKEN) return { ...out, axiom: off('Not connected: AXIOM_TOKEN secret is not set.') };
  const dataset = url.searchParams.get('env') || 'production', service = url.searchParams.get('service') || '';
  const [hours, bin] = RANGES[url.searchParams.get('range')] || RANGES['24h'];
  if (!cfg.telemetry.axiom.datasets.includes(dataset) || !/^[\w.-]*$/.test(service)) return { ...out, error: 'invalid env or service' };
  const base = `['${dataset}'] | where column_ifexists('kind', '') == "server" and column_ifexists('attributes.http.request.method', '') != "OPTIONS"` +
    (service ? ` and column_ifexists('service.name', '') == "${service}"` : '');
  const agg = `requests = count(), errors = countif(${IS_ERROR}), errors_5xx = countif(${IS_5XX}), ` +
    [50, 90, 95, 99].map(p => `p${p} = percentile(${DUR}, ${p}) / 1000000.0`).join(', ');
  try {
    const [series, services] = await Promise.all([
      apl(env, `${base} | summarize ${agg} by bin(_time, ${bin}) | order by _time asc`, hours),
      apl(env, `${base} | summarize ${agg} by service = column_ifexists('service.name', '') | order by requests desc`, hours),
    ]);
    const slos = [];
    for (const s of cfg.slos.filter(s => s.environment === dataset && (!service || s.service === service))) {
      const [r] = await apl(env, `['${dataset}'] | where column_ifexists('kind', '') == "server" and column_ifexists('service.name', '') == "${s.service}" | summarize requests = count(), errors_5xx = countif(${IS_5XX})`, s.windowDays * 24);
      const availability = r?.requests ? 100 * (1 - r.errors_5xx / r.requests) : null;
      slos.push({ ...s, availability, budget_consumed_pct: availability == null ? null : (100 * (100 - availability)) / (100 - s.availabilityTarget) });
    }
    return { ...out, axiom: { connected: true, dataset, service, range: url.searchParams.get('range') || '24h', series, services, slos } };
  } catch (e) {
    return { ...out, axiom: { connected: false, reason: `Axiom query failed: ${e.message}` } };
  }
}

async function api(req, env, url) {
  const db = env.DB, path = url.pathname;
  if (req.method === 'GET' && path === '/api/tickets') {
    const rows = (await db.prepare(`SELECT ${LIST_COLUMNS} FROM tickets WHERE ${SHOWN}`).all()).results;
    const now = Date.now();
    return json({
      now: new Date(now).toISOString(), ...(await meta(db)),
      config: { people: cfg.people, staleDays: cfg.staleDays, priority: cfg.priority, sla: cfg.sla, readProjectFields: cfg.readProjectFields, fixEnvironments: cfg.fixEnvironments },
      tickets: rows.map(r => enrich(cfg, r, now)),
    });
  }
  const one = path.match(/^\/api\/tickets\/(.+)$/);
  if (req.method === 'GET' && one) {
    const id = decodeURIComponent(one[1]);
    const row = await db.prepare('SELECT * FROM tickets WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'not found' }, 404);
    const timeline = JSON.parse(row.timeline || '[]');
    const t = enrich(cfg, row);
    return json({
      ticket: { ...t, body: row.body, timeline, durations: statusDurations(cfg, t, timeline) },
      snapshots: (await db.prepare('SELECT s.sync_id, s.captured_at, s.data, y.policy_version FROM snapshots s LEFT JOIN syncs y ON y.id = s.sync_id WHERE s.ticket_id = ? ORDER BY s.sync_id').bind(id).all()).results,
      changes: (await db.prepare('SELECT * FROM changes WHERE ticket_id = ? ORDER BY id').bind(id).all()).results,
    });
  }
  if (req.method === 'GET' && path === '/api/changes') {
    const from = url.searchParams.get('from') || new Date(Date.now() - 30 * 864e5).toISOString();
    return json((await db.prepare(`SELECT c.*, t.repo, t.number, t.title, t.url, t.kind FROM changes c JOIN tickets t ON t.id = c.ticket_id WHERE c.at >= ? AND t.${SHOWN} ORDER BY c.id DESC LIMIT 5000`).bind(from).all()).results);
  }
  if (req.method === 'GET' && path === '/api/syncs') return json((await db.prepare('SELECT * FROM syncs ORDER BY id DESC LIMIT 60').all()).results);
  if (req.method === 'GET' && path === '/api/health') return json(await health(env, url));
  if (req.method === 'POST' && path === '/api/sync') {
    const since = url.searchParams.get('ifNoSuccessSince');
    if (since && (await db.prepare("SELECT id FROM syncs WHERE status='success' AND started_at >= ?").bind(since).first())) return json({ skipped: 'already synced successfully', summary: null });
    const result = await sync(db, cfg, { token: env.GITHUB_TOKEN, trigger: url.searchParams.get('trigger') === 'claude-hook' ? 'claude-hook' : 'manual', full: url.searchParams.get('full') === '1' });
    return json({ ...result, summary: await report(db, cfg, result) });
  }
  return json({ error: 'not found' }, 404);
}

async function handle(req, env) {
  const url = new URL(req.url);
  if (!(await authorized(req, env))) return new Response('Unauthorized', { status: 401 });
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
  const origin = req.headers.get('origin');
  if (req.method !== 'GET' && origin && origin !== url.origin) return json({ error: 'cross-origin request refused' }, 403);
  return api(req, env, url);
}

export default {
  async fetch(req, env) {
    let res;
    try {
      res = await handle(req, env);
    } catch (e) {
      console.error('request failed:', e.message);
      res = json({ error: 'internal error' }, 500);
    }
    res = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sync(env.DB, cfg, { token: env.GITHUB_TOKEN, trigger: 'cron' }).then(r => console.log('sync', r.id, r.status, JSON.stringify(r.stats))));
  },
};
