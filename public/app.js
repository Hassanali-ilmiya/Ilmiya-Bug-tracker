// All numbers on this page are computed from synced source data returned by /api/*.
const DAY = 864e5;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = u => (/^https:\/\/github\.com\//.test(u || '') ? u : '#');
const fmtDate = s => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const fmtTime = s => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const ago = s => { if (!s) return 'never'; const h = (Date.now() - Date.parse(s)) / 3600e3; return h < 1 ? `${Math.round(h * 60)} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`; };
const hours = h => (h == null ? '—' : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`);
const ref = t => `${t.repo.split('/')[1]}#${t.number}`;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

let data, changesCache;
const load = async () => { data = await api('/api/tickets'); changesCache = null; renderBanner(); };
const changes = async () => (changesCache ??= await api('/api/changes'));
const issues = () => data.tickets.filter(t => t.kind === 'issue');

// ---------- badges ----------
const SEV = { critical: ['critical', '▲ Critical'], high: ['high', '▲ High'], normal: ['', 'Normal'], unknown: ['', 'No priority'] };
const sevBadge = t => `<span class="b ${SEV[t.severity][0]}" title="priority ${esc(t.priority ?? 'none')} from ${esc(t.priority_source ?? 'no source field')}">${esc(t.priority ?? SEV[t.severity][1])}</span>`;
const SLA_B = { breached: ['critical', '✕ SLA breached'], at_risk: ['warning', '! SLA at risk'], ok: ['good', '✓ Within SLA'], met: ['good', '✓ SLA met'], 'n/a': ['', 'SLA n/a'], not_configured: ['', 'Policy not configured'] };
const slaBadge = t => `<span class="b ${SLA_B[t.sla.state][0]}">${SLA_B[t.sla.state][1]}</span>`;
const flags = t => [
  t.blocked && '<span class="b warning">⛔ Blocked</span>',
  t.overdue && `<span class="b critical" title="${esc(t.overdue_reason)}">⏰ Overdue</span>`,
  t.stale && `<span class="b" title="no source activity for ${t.inactive_days} days">💤 ${t.inactive_days}d idle</span>`,
  t.reopened && '<span class="b">↺ Reopened</span>',
  t.missing_since && `<span class="b approx" title="not returned by the last complete full sync">Missing at source</span>`,
].filter(Boolean).join('');
const FIX = { production: 'good', staging: 'warning', dev: 'serious' };
const fixTitle = t => t.fix.evidence.map(e => `${e.repo.split('/')[1]}@${e.sha} ${e.subject}\n   on: ${Object.entries(e.branches).filter(([, v]) => v).map(([b]) => b).join(', ') || 'no environment branch'}`).join('\n');
const fixBadge = t => (t.fix.env ? `<span class="b ${FIX[t.fix.env] ?? ''}" title="${esc(fixTitle(t))}">${esc(t.fix.env)}</span>` : `<span class="muted small" title="${esc(fixTitle(t))}">${esc(t.fixed_in === 'no fix evidence' ? '—' : t.fixed_in)}</span>`);
const statusBadge = t => `${esc(t.status)} <span class="b ${t.status_source === 'project' ? 'src' : 'derived'}" title="${t.status_source === 'project' ? 'GitHub Project Status field' : 'derived from state, labels, assignees and linked PRs'}">${t.status_source}</span>`;

// ---------- metrics (each is a filter preset, so every tile opens its ticket list) ----------
const within = (s, ms) => s && Date.parse(s) >= ms;
const PRESETS = {
  open: { label: 'Open', f: t => t.state === 'OPEN' },
  created_today: { label: 'Created today', f: t => within(t.created_at, startOfToday()) },
  created_week: { label: 'Created last 7 days', f: t => within(t.created_at, Date.now() - 7 * DAY) },
  done_today: { label: 'Completed today', f: t => within(t.resolved_at, startOfToday()) },
  done_week: { label: 'Completed last 7 days', f: t => within(t.resolved_at, Date.now() - 7 * DAY) },
  in_progress: { label: 'In progress', f: t => t.in_progress },
  blocked: { label: 'Blocked', f: t => t.blocked },
  overdue: { label: 'Overdue', f: t => t.overdue },
  sla_risk: { label: 'Approaching SLA', f: t => t.state === 'OPEN' && t.sla.state === 'at_risk' },
  crit_high: { label: 'Critical / high open', f: t => t.state === 'OPEN' && ['critical', 'high'].includes(t.severity) },
  unassigned: { label: 'Unassigned', f: t => t.state === 'OPEN' && !t.assignees.length },
  stale: { label: 'No recent activity', f: t => t.stale },
  reopened: { label: 'Reopened after completion', f: t => t.state === 'OPEN' && t.reopened },
  fix_dev: { label: 'Open, fix only on dev', f: t => t.state === 'OPEN' && t.fix.env === 'dev' },
  fix_staging: { label: 'Open, fix on staging', f: t => t.state === 'OPEN' && t.fix.env === 'staging' },
  fix_prod: { label: 'Open, fix on production', f: t => t.state === 'OPEN' && t.fix.env === 'production' },
};

// ---------- banner / sync ----------
function renderBanner() {
  const { lastSync: l, lastSuccess: ok } = data;
  $('#sync-age').textContent = `Last successful sync: ${ago(ok?.started_at)}`;
  let cls = '', msg = '';
  if (!ok) [cls, msg] = ['bad', 'No successful sync yet. Nothing below can be treated as current.'];
  else if (l && l.id !== ok.id && l.status !== 'running') [cls, msg] = ['bad', `Latest sync #${l.id} (${fmtTime(l.started_at)}) was ${l.status.toUpperCase()}: ${JSON.parse(l.errors || '[]').map(e => `${e.scope}: ${e.error}`).join('; ')}. Data shown is from the last successful sync at ${fmtTime(ok.started_at)}.`];
  else if (l?.status === 'running') [cls, msg] = ['warn', `Sync #${l.id} is running (started ${fmtTime(l.started_at)}).`];
  else if (Date.now() - Date.parse(ok.started_at) > 26 * 3600e3) [cls, msg] = ['warn', `Data is stale: last successful sync was ${ago(ok.started_at)} (${fmtTime(ok.started_at)}).`];
  $('#banner').innerHTML = msg ? `<p class="banner ${cls}">${esc(msg)}</p>` : '';
}

$('#sync-now').addEventListener('click', async e => {
  e.target.disabled = true; e.target.textContent = 'Syncing…';
  try {
    const r = await api('/api/sync', { method: 'POST' });
    await load();
    $('#banner').insertAdjacentHTML('beforeend', `<p class="banner ${r.status === 'success' ? '' : 'bad'}">${esc(r.skipped ? `Sync skipped: ${r.skipped}` : `Sync #${r.id} ${r.status}: ${r.stats.fetched} fetched, ${r.stats.new} new, ${r.stats.changed} changed${r.errors.length ? ` — errors: ${r.errors.map(x => x.error).join('; ')}` : ''}`)}</p>`);
    route();
  } catch (err) {
    $('#banner').innerHTML = `<p class="banner bad">Sync request failed: ${esc(err.message)}</p>`;
  } finally { e.target.disabled = false; e.target.textContent = 'Sync now'; }
});

// ---------- charts (single y-axis, ≤3 series, hover tooltip, table fallback) ----------
const tip = $('#tip');
const showTip = (ev, html) => { tip.innerHTML = html; tip.hidden = false; tip.style.left = `${Math.min(ev.clientX + 12, innerWidth - 220)}px`; tip.style.top = `${ev.clientY + 12}px`; };
const hideTip = () => { tip.hidden = true; };
const niceMax = v => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p / (v / p > 5 ? 2 : 1)) * p * (v / p > 5 ? 2 : 1); };
const legend = series => (series.length > 1 ? `<div class="legend">${series.map((s, i) => `<span><span class="sw s${i + 1}"></span>${esc(s.name)}</span>`).join('')}</div>` : '');
const dataTable = (labels, series, fmt) => `<details><summary>Data table</summary><div class="scroll"><table><tr><th></th>${series.map(s => `<th class="num">${esc(s.name)}</th>`).join('')}</tr>${labels.map((l, i) => `<tr><td>${esc(l)}</td>${series.map(s => `<td class="num">${s.values[i] == null ? '—' : esc(fmt(s.values[i]))}</td>`).join('')}</tr>`).join('')}</table></div></details>`;

function chart(el, { labels, series, type = 'line', fmt = v => String(Math.round(v)) }) {
  const W = Math.max(320, el.clientWidth || 600), H = 220, m = { l: 44, r: 10, t: 10, b: 24 };
  const max = niceMax(Math.max(0, ...series.flatMap(s => s.values.filter(v => v != null))));
  const pw = W - m.l - m.r, ph = H - m.t - m.b, n = labels.length;
  const y = v => m.t + ph - (v / max) * ph;
  const band = pw / n, x = i => (type === 'bar' ? m.l + band * i + band / 2 : m.l + (n < 2 ? pw / 2 : (i * pw) / (n - 1)));
  let svg = [0, 0.25, 0.5, 0.75, 1].map(f => `<line class="gl" x1="${m.l}" x2="${W - m.r}" y1="${y(max * f)}" y2="${y(max * f)}"/><text x="${m.l - 6}" y="${y(max * f) + 4}" text-anchor="end">${esc(fmt(max * f))}</text>`).join('');
  svg += `<line class="base" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
  [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i && v >= 0).forEach(i => (svg += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(labels[i])}</text>`));
  if (type === 'bar') {
    const bw = Math.max(2, (band - 4) / series.length);
    series.forEach((s, k) => s.values.forEach((v, i) => {
      if (!v) return;
      const bx = m.l + band * i + 2 + k * bw, h = y(0) - y(v), r = Math.min(4, bw / 2, h);
      svg += `<path class="bar s${k + 1}" d="M${bx},${y(0)} V${y(v) + r} q0,-${r} ${r},-${r} H${bx + bw - r} q${r},0 ${r},${r} V${y(0)} Z"/>`;
    }));
  } else {
    series.forEach((s, k) => {
      const d = s.values.map((v, i) => (v == null ? '' : `${i && s.values[i - 1] != null ? 'L' : 'M'}${x(i)},${y(v)}`)).join('');
      svg += `<path class="ln s${k + 1}" d="${d}"/>`;
    });
  }
  svg += `<line class="xh" y1="${m.t}" y2="${y(0)}" visibility="hidden"/><g class="dots"></g><rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="transparent" class="hit"/>`;
  el.innerHTML = `${legend(series)}<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img">${svg}</svg></div>${dataTable(labels, series, fmt)}`;
  const s = el.querySelector('svg'), xh = s.querySelector('.xh'), dots = s.querySelector('.dots');
  s.querySelector('.hit').addEventListener('mousemove', ev => {
    const p = s.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY;
    const px = p.matrixTransform(s.getScreenCTM().inverse()).x;
    const i = Math.max(0, Math.min(n - 1, type === 'bar' ? Math.floor((px - m.l) / band) : Math.round(((px - m.l) / pw) * (n - 1))));
    xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
    dots.innerHTML = type === 'line' ? series.map((se, k) => (se.values[i] == null ? '' : `<circle class="dot s${k + 1}" r="4" cx="${x(i)}" cy="${y(se.values[i])}"/>`)).join('') : '';
    showTip(ev, `<b>${esc(labels[i])}</b><br>${series.map((se, k) => `<span class="sw s${k + 1}"></span>${esc(se.name)}: ${se.values[i] == null ? '—' : esc(fmt(se.values[i]))}`).join('<br>')}`);
  });
  s.querySelector('.hit').addEventListener('mouseleave', () => { hideTip(); xh.setAttribute('visibility', 'hidden'); dots.innerHTML = ''; });
}

// Open count at end of each day from created/closed timestamps (reopen cycles are not reconstructed).
const openAt = (list, ms) => list.filter(t => Date.parse(t.created_at) <= ms && (!t.closed_at || Date.parse(t.closed_at) > ms)).length;

// ---------- views ----------
function overview(view) {
  const list = issues();
  const tiles = Object.entries(PRESETS).map(([k, p]) => `<a class="tile" href="#/tickets?preset=${k}"><div class="v">${list.filter(p.f).length}</div><div class="l">${esc(p.label)}</div></a>`).join('');
  const days = Array.from({ length: 60 }, (_, i) => startOfToday() + DAY - (59 - i) * DAY - 1);
  const weeks = Array.from({ length: 12 }, (_, i) => startOfToday() + DAY - (11 - i) * 7 * DAY);
  const inWeek = (s, end) => s && Date.parse(s) < end && Date.parse(s) >= end - 7 * DAY;
  view.innerHTML = `<h1>Executive overview</h1>
    <p class="muted small">Scope: issues created by ${esc(data.config.people.me)} across ${new Set(list.map(t => t.repo)).size} repositories (${list.length} issues). Click any number for the matching tickets. Severity comes from priority (${esc(data.config.priority.critical.join('/'))} = critical, ${esc(data.config.priority.high.join('/'))} = high); ${list.filter(t => !t.priority).length} issues have no priority in any readable source field.</p>
    <div class="tiles">${tiles}</div>
    <div class="grid2">
      <div class="card"><h2>Open issues (end of day, last 60 days)</h2><p class="muted small">Approximate: reconstructed from created/closed timestamps; reopen cycles are not replayed.</p><div id="c-open"></div></div>
      <div class="card"><h2>Created vs completed per week</h2><div id="c-weekly"></div></div>
    </div>
    <div class="card"><h2>Repositories and types: last 7 days</h2><div id="trend"></div></div>`;
  chart($('#c-open'), { labels: days.map(d => fmtDate(new Date(d).toISOString())), series: [{ name: 'Open', values: days.map(d => openAt(list, d)) }] });
  chart($('#c-weekly'), { type: 'bar', labels: weeks.map(w => `wk of ${fmtDate(new Date(w - 7 * DAY).toISOString())}`), series: [{ name: 'Created', values: weeks.map(w => list.filter(t => inWeek(t.created_at, w)).length) }, { name: 'Completed', values: weeks.map(w => list.filter(t => inWeek(t.resolved_at, w)).length) }] });
  $('#trend').innerHTML = trendTable(list);
}

function trendTable(list) {
  const weekAgo = Date.now() - 7 * DAY;
  const rows = [...['repo', 'type'].flatMap(dim => [...new Set(list.map(t => t[dim]))].map(v => {
    const g = list.filter(t => t[dim] === v);
    const now = g.filter(t => t.state === 'OPEN').length, before = openAt(g, weekAgo);
    return { dim, v, now, before, created: g.filter(t => within(t.created_at, weekAgo)).length, done: g.filter(t => within(t.resolved_at, weekAgo)).length };
  }))].sort((a, b) => b.now - b.before - (a.now - a.before));
  return `<div class="scroll"><table><tr><th>Group</th><th class="num">Open 7 d ago</th><th class="num">Open now</th><th class="num">Change</th><th class="num">Created</th><th class="num">Completed</th><th>Direction</th></tr>
    ${rows.map(r => { const d = r.now - r.before; return `<tr><td>${esc(r.dim)}: ${esc(r.v)}</td><td class="num">${r.before}</td><td class="num">${r.now}</td><td class="num">${d > 0 ? '+' : ''}${d}</td><td class="num">${r.created}</td><td class="num">${r.done}</td><td>${d > 0 ? '<span class="b serious">▲ backlog growing</span>' : d < 0 ? '<span class="b good">▼ improving</span>' : '<span class="b">no change</span>'}</td></tr>`; }).join('')}</table></div>`;
}

const SEV_ORDER = { critical: 0, high: 1, normal: 2, unknown: 3 };
const SLA_ORDER = { breached: 0, at_risk: 1, ok: 2, not_configured: 3, met: 4, 'n/a': 5 };
const SORTS = {
  severity: (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || (a.priority ?? 'Z').localeCompare(b.priority ?? 'Z'),
  oldest: (a, b) => (a.state === 'OPEN') !== (b.state === 'OPEN') ? (a.state === 'OPEN' ? -1 : 1) : a.created_at.localeCompare(b.created_at),
  sla: (a, b) => SLA_ORDER[a.sla.state] - SLA_ORDER[b.sla.state],
  inactivity: (a, b) => b.inactive_days - a.inactive_days,
  updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
};

function tickets(view, params) {
  const p = Object.fromEntries(params);
  const all = data.tickets;
  const opts = (key, values, label) => `<select data-k="${key}" aria-label="${label}"><option value="">${label}: all</option>${[...new Set(values)].filter(Boolean).sort().map(v => `<option ${p[key] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
  let list = all;
  if (p.preset && PRESETS[p.preset]) list = list.filter(PRESETS[p.preset].f);
  if (p.kind) list = list.filter(t => t.kind === p.kind);
  for (const k of ['repo', 'status', 'severity', 'type', 'fixed_in']) if (p[k]) list = list.filter(t => t[k] === p[k]);
  if (p.assignee) list = list.filter(t => (p.assignee === '(unassigned)' ? !t.assignees.length : t.assignees.includes(p.assignee)));
  if (p.sla) list = list.filter(t => t.sla.state === p.sla);
  if (p.from) list = list.filter(t => t.created_at >= p.from);
  if (p.to) list = list.filter(t => t.created_at.slice(0, 10) <= p.to);
  if (p.q) { const q = p.q.toLowerCase(); list = list.filter(t => `${ref(t)} ${t.title} ${t.labels.join(' ')}`.toLowerCase().includes(q)); }
  list = [...list].sort(SORTS[p.sort || 'severity']);
  const page = Number(p.page || 0), per = 100, rows = list.slice(page * per, page * per + per);
  view.innerHTML = `<h1>Ticket register ${p.preset && PRESETS[p.preset] ? `— ${esc(PRESETS[p.preset].label)}` : ''}</h1>
    <div class="filters">
      <input type="search" data-k="q" placeholder="Search ID, title, label" value="${esc(p.q)}">
      <select data-k="preset" aria-label="Metric"><option value="">Metric: all</option>${Object.entries(PRESETS).map(([k, v]) => `<option value="${k}" ${p.preset === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
      ${new Set(all.map(t => t.kind)).size > 1 ? opts('kind', all.map(t => t.kind), 'Kind') : ''}
      ${opts('repo', all.map(t => t.repo), 'Repository')}
      ${opts('assignee', [...all.flatMap(t => t.assignees), '(unassigned)'], 'Assignee')}
      ${opts('status', all.map(t => t.status), 'Status')}
      ${opts('severity', all.map(t => t.severity), 'Severity')}
      ${opts('type', all.map(t => t.type), 'Type')}
      ${opts('sla', all.map(t => t.sla.state), 'SLA')}
      ${opts('fixed_in', all.map(t => t.fixed_in), 'Fixed in')}
      <label class="small">Created from <input type="date" data-k="from" value="${esc(p.from)}"></label>
      <label class="small">to <input type="date" data-k="to" value="${esc(p.to)}"></label>
      <select data-k="sort" aria-label="Sort">${[['severity', 'Severity'], ['oldest', 'Oldest open'], ['sla', 'SLA risk'], ['inactivity', 'Inactivity'], ['updated', 'Last update']].map(([v, l]) => `<option value="${v}" ${(p.sort || 'severity') === v ? 'selected' : ''}>Sort: ${l}</option>`).join('')}</select>
      <a href="#/tickets">Clear</a>
    </div>
    <p class="muted small">${list.length} tickets</p>
    <div class="scroll"><table>
      <tr><th>ID</th><th>Title</th><th>Repo</th><th>Type</th><th>Priority</th><th>Status</th><th>Fixed in</th><th>Assignee</th><th>Created</th><th>Updated</th><th class="num">Days open</th><th>SLA</th><th>Flags</th><th>Last activity</th><th>Source</th></tr>
      ${rows.map(t => `<tr>
        <td class="nowrap"><a href="#/ticket/${encodeURIComponent(t.id)}">${esc(ref(t))}</a></td>
        <td class="title">${esc(t.title)}</td><td>${esc(t.repo.split('/')[1])}</td><td>${esc(t.type)}</td><td>${sevBadge(t)}</td>
        <td class="nowrap">${statusBadge(t)}</td><td>${fixBadge(t)}</td><td>${esc(t.assignees.join(', ') || '—')}</td>
        <td class="nowrap">${fmtDate(t.created_at)}</td><td class="nowrap">${fmtDate(t.updated_at)}</td><td class="num">${t.days_open}</td>
        <td>${slaBadge(t)}${t.sla.resolution?.due ? `<div class="small muted">due ${fmtDate(t.sla.resolution.due)}${t.sla.resolution.remaining_hours != null ? `, ${hours(t.sla.resolution.remaining_hours)} left` : ''}</div>` : ''}</td>
        <td>${flags(t)}</td><td class="nowrap">${fmtDate(t.last_activity)}${t.history_approx ? ' <span class="b approx">approx</span>' : ''}</td>
        <td><a href="${esc(safeUrl(t.url))}" target="_blank" rel="noopener noreferrer">GitHub ↗</a></td></tr>`).join('')}
    </table></div>
    <div class="pager">${page > 0 ? `<button data-page="${page - 1}">← Prev</button>` : ''}<span class="muted small">Page ${page + 1} of ${Math.max(1, Math.ceil(list.length / per))}</span>${(page + 1) * per < list.length ? `<button data-page="${page + 1}">Next →</button>` : ''}</div>`;
  const update = (k, v) => { const np = new URLSearchParams(params); v ? np.set(k, v) : np.delete(k); if (k !== 'page') np.delete('page'); location.hash = `#/tickets?${np}`; };
  view.querySelectorAll('[data-k]').forEach(el => el.addEventListener(el.type === 'search' ? 'search' : 'change', () => update(el.dataset.k, el.value)));
  view.querySelector('input[type=search]').addEventListener('keydown', e => e.key === 'Enter' && update('q', e.target.value));
  view.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => update('page', b.dataset.page)));
}

function describeEvent(e) {
  const who = esc(e.actor ?? 'someone');
  switch (e.t) {
    case 'comment': return `${who} commented${e.text ? `<div class="text">${esc(e.text)}</div>` : ''}`;
    case 'assigned': return `${who} assigned ${esc(e.who)}`;
    case 'unassigned': return `${who} unassigned ${esc(e.who)}`;
    case 'labeled': return `${who} added label <span class="b">${esc(e.label)}</span>`;
    case 'unlabeled': return `${who} removed label <span class="b">${esc(e.label)}</span>`;
    case 'closed': return `${who} closed it (${esc(e.reason ?? 'no reason')})`;
    case 'reopened': return `${who} reopened it`;
    case 'xref': case 'connected': return `${who} linked ${esc(e.kind === 'PullRequest' ? 'PR' : 'issue')} <a href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener noreferrer">${esc(e.ref)}</a> (${esc(e.state)} when synced)`;
    case 'milestoned': return `${who} set milestone ${esc(e.milestone)}`;
    case 'demilestoned': return `${who} removed milestone ${esc(e.milestone)}`;
    case 'review': return `${who} reviewed (${esc(e.review)})`;
    default: return `${who} ${esc(e.t)}`;
  }
}

async function detail(view, id) {
  const { ticket: t, snapshots, changes: ch } = await api(`/api/tickets/${encodeURIComponent(id)}`);
  const tl = t.timeline;
  const comments = tl.filter(e => e.t === 'comment'), lastEv = tl.at(-1);
  const summary = [
    `${comments.length} comment(s) from ${new Set(comments.map(c => c.actor)).size} people`,
    `${t.linked_prs.length} linked PR(s) (${t.linked_prs.filter(p => p.state === 'MERGED').length} merged, ${t.linked_prs.filter(p => p.state === 'OPEN').length} open)`,
    t.work_started_at ? `work first observed ${fmtDate(t.work_started_at)} (first assignment or linked PR)` : 'no assignment or linked PR yet',
    lastEv ? `last source event: ${lastEv.t} by ${lastEv.actor ?? 'unknown'} ${ago(lastEv.at)}` : 'no source events after creation',
  ];
  const sla = t.sla.state === 'not_configured' ? '<p class="notice">Policy not configured: no SLA target applies to this ticket, so it is never classified as breached.</p>'
    : `<dl class="kv"><dt>Policy</dt><dd>${esc(t.sla.policy)} (clock: ${esc(t.sla.clock)})</dd>${['response', 'resolution'].map(k => t.sla[k] ? `<dt>${k}</dt><dd>${slaBadge({ sla: t.sla[k] })} due ${fmtTime(t.sla[k].due)}${t.sla[k].breach_hours ? `, breached by ${hours(t.sla[k].breach_hours)}` : ''}${t.sla[k].remaining_hours != null ? `, ${hours(t.sla[k].remaining_hours)} left` : ''}</dd>` : '').join('')}</dl>`;
  const slaHistory = snapshots.map(s => ({ ...JSON.parse(s.data), at: s.captured_at, v: s.policy_version }));
  view.innerHTML = `<p><a href="#/tickets">← Ticket register</a></p>
    <h1>${esc(ref(t))}: ${esc(t.title)}</h1>
    <p>${statusBadge(t)} ${sevBadge(t)} ${slaBadge(t)} ${flags(t)} <a href="${esc(safeUrl(t.url))}" target="_blank" rel="noopener noreferrer">Open in GitHub ↗</a></p>
    <p class="small muted">Badges: <span class="b src">source</span> = read from GitHub; <span class="b derived">derived</span> = computed by this dashboard from source fields; <span class="b approx">approx</span> = source history incomplete.</p>
    <div class="grid2">
      <div class="card"><h2>Current state <span class="b src">source</span></h2><dl class="kv">
        <dt>State</dt><dd>${esc(t.state)}${t.state_reason ? ` (${esc(t.state_reason)})` : ''}</dd>
        <dt>Assignees</dt><dd>${esc(t.assignees.join(', ') || 'unassigned')}</dd>
        <dt>Author</dt><dd>${esc(t.author)}</dd>
        <dt>Priority</dt><dd>${esc(t.priority ?? 'none')} ${t.priority_source ? `<span class="b src">from ${esc(t.priority_source)}</span>` : ''}</dd>
        <dt>Type</dt><dd>${esc(t.type)}</dd>
        <dt>Labels</dt><dd>${t.labels.map(l => `<span class="b">${esc(l)}</span>`).join('') || '—'}</dd>
        <dt>Milestone</dt><dd>${esc(t.milestone ?? '—')}${t.milestone_due ? ` (due ${fmtDate(t.milestone_due)})` : ''}</dd>
        <dt>Created</dt><dd>${fmtTime(t.created_at)}</dd><dt>Updated</dt><dd>${fmtTime(t.updated_at)}</dd><dt>Closed</dt><dd>${fmtTime(t.closed_at)}</dd>
        <dt>Blocked by</dt><dd>${t.blocked_by.map(b => `${esc(b.ref)} (${esc(b.state)})`).join(', ') || '—'}</dd>
        <dt>Last synced</dt><dd>${fmtTime(t.synced_at)}</dd>
      </dl></div>
      <div class="card"><h2>Progress <span class="b derived">derived</span></h2><dl class="kv">
        <dt>Days open</dt><dd>${t.days_open}</dd>
        <dt>Last activity</dt><dd>${fmtTime(t.last_activity)} (${t.inactive_days} d ago)${t.history_approx ? ' <span class="b approx">approx</span>' : ''}</dd>
        <dt>First response</dt><dd>${fmtTime(t.first_response_at)} <span class="muted small">(first comment by someone other than the author)</span></dd>
        <dt>Work started</dt><dd>${fmtTime(t.work_started_at)}</dd>
        <dt>Time open / closed / blocked</dt><dd>${hours(t.durations.open_hours)} / ${hours(t.durations.closed_hours)} / ${hours(t.durations.blocked_hours)}</dd>
      </dl><h3>Generated summary of source activity</h3><ul class="plain">${summary.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      <h3>Fixed in <span class="b derived">derived</span></h3><p>${fixBadge(t)} <span class="muted small">The highest branch that contains every fix change (${esc(data.config.fixEnvironments?.branches.map(([b, e]) => `${b} = ${e}`).join(', ') ?? 'not configured')}). That shows the code is present on the branch, not that a deploy was verified.</span></p>
      ${t.fix.evidence.length ? `<div class="scroll"><table><tr><th>Fix change</th>${data.config.fixEnvironments.branches.map(([b, e]) => `<th>${esc(b)} (${esc(e)})</th>`).join('')}</tr>${t.fix.evidence.map(e => `<tr><td><a href="https://github.com/${esc(e.repo)}/commit/${esc(e.sha)}" target="_blank" rel="noopener noreferrer">${esc(e.repo.split('/')[1])}@${esc(e.sha)}</a> ${esc(e.subject)}<div class="muted small">found via ${esc(e.via)}</div></td>${data.config.fixEnvironments.branches.map(([b]) => `<td>${e.branches[b] ? '<span class="b good">✓ present</span>' : '<span class="b">✕ absent</span>'}</td>`).join('')}</tr>`).join('')}</table></div><p class="muted small">Checked ${fmtTime(t.fix.checked_at)}. Shown environment = highest branch containing every change above.</p>` : '<p class="muted small">No fix evidence: no commit on an environment branch references this issue, and no "fixed" comment links a commit.</p>'}
      <h3>Linked pull requests</h3>${t.linked_prs.map(p => `<a href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener noreferrer">${esc(p.ref)}</a> <span class="b">${esc(p.state)}</span>`).join('<br>') || '<span class="muted">None discovered</span>'}</div>
    </div>
    <div class="card"><h2>SLA</h2>${sla}
      <h3>Deadline history (per snapshot, with policy version)</h3><div class="scroll"><table><tr><th>Captured</th><th>Policy version</th><th>Policy</th><th>Response due</th><th>Resolution due</th></tr>${slaHistory.map(s => `<tr><td>${fmtTime(s.at)}</td><td>${esc(s.v)}</td><td>${esc(s.sla_policy ?? 'not configured')}</td><td>${fmtTime(s.response_due)}</td><td>${fmtTime(s.resolution_due)}</td></tr>`).join('')}</table></div></div>
    <div class="card"><h2>Changes observed between syncs <span class="b src">snapshot diff</span></h2>${ch.length ? `<div class="scroll"><table><tr><th>Observed</th><th>Field</th><th>From</th><th>To</th></tr>${ch.map(c => `<tr><td class="nowrap">${fmtTime(c.at)}</td><td>${esc(c.field)}</td><td>${esc(c.old ?? '∅')}</td><td>${esc(c.new ?? '∅')}</td></tr>`).join('')}</table></div>` : '<p class="muted">No changes observed since this ticket was first synced.</p>'}</div>
    <div class="card"><h2>Source timeline <span class="b src">source</span>${t.timeline_truncated ? ' <span class="b approx">first 100 events only</span>' : ''}</h2>
      <ul class="timeline"><li><span class="muted small">${fmtTime(t.created_at)}</span> ${esc(t.author)} opened the issue</li>${tl.map(e => `<li><span class="muted small">${fmtTime(e.at)}</span> ${describeEvent(e)}</li>`).join('')}</ul></div>
    <div class="card"><h2>Original description <span class="b src">source</span></h2><pre class="body">${esc(t.body || '(empty)')}</pre></div>`;
}

async function progress(view, params) {
  const day = params.get('day') || new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00`).getTime(), end = start + DAY;
  const [ch, syncs] = await Promise.all([changes(), api('/api/syncs')]);
  const list = issues(), byId = Object.fromEntries(data.tickets.map(t => [t.id, t]));
  const inDay = s => s && Date.parse(s) >= start && Date.parse(s) < end;
  const dayCh = ch.filter(c => inDay(c.at));
  const daySyncs = syncs.filter(s => inDay(s.started_at));
  const open = list.filter(t => t.state === 'OPEN');
  const link = t => `<a href="#/ticket/${encodeURIComponent(t.id)}">${esc(ref(t))}</a> ${esc(t.title)}`;
  const section = (title, items, render, empty) => `<div class="card"><h2>${title} (${items.length})</h2>${items.length ? `<ul class="plain">${items.map(i => `<li>${render(i)}</li>`).join('')}</ul>` : `<p class="muted">${empty}</p>`}</div>`;
  const people = data.config.people;
  const attention = open.filter(t => (t.assignees.some(a => Object.values(people).includes(a)) || !t.assignees.length) && (t.blocked || t.overdue || ['critical', 'high'].includes(t.severity) || t.sla.state === 'breached'));
  const risks = [...open.filter(t => t.severity === 'critical'), ...open.filter(t => t.sla.state === 'breached'), ...open.filter(t => t.blocked && t.severity === 'high')].filter((t, i, a) => a.indexOf(t) === i);
  view.innerHTML = `<h1>Progress report</h1>
    <div class="filters"><label>Day <input type="date" id="day" value="${esc(day)}"></label><span class="muted small">Completed = source close timestamp on that day. Changes = differences between consecutive sync snapshots, so a ticket is counted once when it changes, never again on later days.</span></div>
    <div class="card"><h2>Sync health for ${esc(day)}</h2>${daySyncs.length ? daySyncs.map(s => `<div>#${s.id} ${esc(s.trigger)} ${esc(s.mode)} at ${fmtTime(s.started_at)}: <span class="b ${s.status === 'success' ? 'good' : s.status === 'running' ? 'warning' : 'critical'}">${esc(s.status)}</span> ${s.errors && s.errors !== '[]' ? esc(s.errors) : ''}</div>`).join('') : '<p class="notice">No sync ran on this day: changes on this day may be missing (missing information, not "no change").</p>'}</div>
    ${section('Verified progress: completed', list.filter(t => inDay(t.resolved_at)), link, 'Nothing was completed on this day.')}
    ${section('New tickets', list.filter(t => inDay(t.created_at)), link, 'None created on this day.')}
    ${section('Changes observed by syncs', dayCh.filter(c => c.field !== '_new'), c => `${byId[c.ticket_id] ? link(byId[c.ticket_id]) : esc(c.ticket_id)} — <b>${esc(c.field)}</b>: ${esc(c.old ?? '∅')} → ${esc(c.new ?? '∅')}`, 'No field changes observed (or no sync ran).')}
    ${section('Blocked (and why)', open.filter(t => t.blocked), t => `${link(t)} — ${esc([t.labels.filter(l => /block/i.test(l)).map(l => `label "${l}"`).join(', '), t.blocked_by.filter(b => b.state === 'OPEN').map(b => `blocked by ${b.ref}`).join(', '), t.project_status && /block/i.test(t.project_status) ? 'project status' : ''].filter(Boolean).join('; ') || 'blocked')}`, 'Nothing is blocked.')}
    ${section('High-severity issues still open', open.filter(t => ['critical', 'high'].includes(t.severity)), t => `${link(t)} ${sevBadge(t)}`, 'None (note: most tickets have no readable priority).')}
    ${section(`No progress (no source activity ≥ ${data.config.staleDays} days)`, open.filter(t => t.stale).sort(SORTS.inactivity), t => `${link(t)} — idle ${t.inactive_days} d`, 'Every open ticket had recent activity.')}
    ${section('Approaching or exceeding SLA', open.filter(t => ['at_risk', 'breached'].includes(t.sla.state)), t => `${link(t)} ${slaBadge(t)}`, data.config.sla.policies.length ? 'None.' : 'SLA policies are not configured, so nothing can be at risk or breached.')}
    ${section('Biggest current risks', risks, t => `${link(t)} ${sevBadge(t)} ${slaBadge(t)} ${flags(t)}`, 'No open critical, SLA-breached, or blocked high-severity tickets.')}
    ${section(`Needs attention from ${Object.values(people).join(' / ')} (or unassigned)`, attention, t => `${link(t)} ${flags(t)} <span class="muted small">${esc(t.assignees.join(', ') || 'unassigned')}</span>`, 'Nothing flagged.')}
    <div class="card"><h2>Projects improving or deteriorating</h2>${trendTable(list)}</div>
    <div class="card"><h2>Activity feed (last 30 days of observed changes)</h2><ul class="timeline">${ch.slice(0, 200).map(c => `<li><span class="muted small">${fmtTime(c.at)}</span> ${byId[c.ticket_id] ? link(byId[c.ticket_id]) : esc(c.ticket_id)} — ${c.field === '_new' ? `<b>${esc(c.new)}</b> (first seen)` : `<b>${esc(c.field)}</b>: ${esc(c.old ?? '∅')} → ${esc(c.new ?? '∅')}`}</li>`).join('') || '<li class="muted">No changes observed yet. The first sync is a baseline; changes appear from the second sync on.</li>'}</ul></div>`;
  $('#day').addEventListener('change', e => (location.hash = `#/progress?day=${e.target.value}`));
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
function sla(view, params) {
  const dim = params.get('by') || 'repo';
  const list = issues(), cfg = data.config;
  const durH = (a, b) => (Date.parse(b) - Date.parse(a)) / 3600e3;
  const stats = g => {
    const res = g.filter(t => t.resolved_at).map(t => durH(t.created_at, t.resolved_at));
    const resp = g.filter(t => t.first_response_at).map(t => durH(t.created_at, t.first_response_at));
    const start = g.filter(t => t.work_started_at).map(t => durH(t.created_at, t.work_started_at));
    const withPolicy = g.filter(t => t.sla.resolution && ['met', 'breached'].includes(t.sla.resolution.state));
    const breaches = g.filter(t => t.sla.resolution?.state === 'breached');
    return {
      n: g.length, resolved: res.length, avg: res.length ? res.reduce((a, b) => a + b, 0) / res.length : null, med: res.length ? pct(res, 50) : null,
      p90: res.length >= 20 ? pct(res, 90) : null, p95: res.length >= 20 ? pct(res, 95) : null,
      resp: resp.length ? pct(resp, 50) : null, respN: resp.length, start: start.length ? pct(start, 50) : null,
      compliance: withPolicy.length ? (100 * withPolicy.filter(t => t.sla.resolution.state === 'met').length) / withPolicy.length : null,
      breaches: breaches.length, breachH: breaches.reduce((a, t) => a + (t.sla.resolution.breach_hours || 0), 0),
    };
  };
  const key = t => (dim === 'assignee' ? t.assignees[0] || '(unassigned)' : t[dim]);
  const groups = [['All issues', list], ...[...new Set(list.map(key))].sort().map(v => [v, list.filter(t => key(t) === v)])];
  const policyNote = cfg.sla.policies.length
    ? `<div class="scroll"><table><tr><th>Policy</th><th>Matches</th><th class="num">Response target</th><th class="num">Resolution target</th></tr>${cfg.sla.policies.map(p => `<tr><td>${esc(p.id)}</td><td>${esc(JSON.stringify(p.match || {}))}</td><td class="num">${hours(p.responseHours)}</td><td class="num">${hours(p.resolutionHours)}</td></tr>`).join('')}</table></div>`
    : '<p class="notice"><b>Policy not configured.</b> No SLA targets have been agreed yet, so no ticket is classified as at risk or breached and compliance is not computed. Time-to-response and time-to-resolution below are measured facts and do not depend on a policy. Add agreed targets to <code>config.json → sla.policies</code>.</p>';
  view.innerHTML = `<h1>SLA</h1>
    <div class="card"><h2>Policies</h2>${policyNote}<p class="small muted">Clock: <b>${esc(cfg.sla.clock)}</b> time (24×7). Business-hours SLAs are not supported yet. Response = first comment by someone other than the author; work started = first assignment or linked PR; resolution = closed as completed (not-planned closures are excluded). Each sync records the policy version used (see a ticket's SLA history).</p></div>
    <div class="filters"><label>Group by <select id="by">${['repo', 'severity', 'assignee', 'type'].map(d => `<option ${d === dim ? 'selected' : ''}>${d}</option>`).join('')}</select></label></div>
    <div class="scroll"><table><tr><th>Group</th><th class="num">Tickets</th><th class="num">Resolved</th><th class="num">Avg resolution</th><th class="num">Median</th><th class="num">P90</th><th class="num">P95</th><th class="num">Median first response</th><th class="num">Median to work start</th><th class="num">Compliance</th><th class="num">Breaches (total duration)</th></tr>
    ${groups.map(([name, g]) => { const s = stats(g); return `<tr><td>${esc(name)}</td><td class="num">${s.n}</td><td class="num">${s.resolved}</td><td class="num">${hours(s.avg)}</td><td class="num">${hours(s.med)}</td><td class="num">${s.p90 == null ? '<span class="muted" title="needs ≥20 resolved">n&lt;20</span>' : hours(s.p90)}</td><td class="num">${s.p95 == null ? '<span class="muted" title="needs ≥20 resolved">n&lt;20</span>' : hours(s.p95)}</td><td class="num">${hours(s.resp)} <span class="muted small">(n=${s.respN})</span></td><td class="num">${hours(s.start)}</td><td class="num">${s.compliance == null ? '<span class="muted">Policy not configured</span>' : `${s.compliance.toFixed(0)}%`}</td><td class="num">${s.compliance == null ? '—' : `${s.breaches} (${hours(s.breachH)})`}</td></tr>`; }).join('')}
    </table></div>
    <div class="card"><h2>Resolution time trend (median per month of closure)</h2><div id="c-res"></div></div>`;
  $('#by').addEventListener('change', e => (location.hash = `#/sla?by=${e.target.value}`));
  const months = [...new Set(list.filter(t => t.resolved_at).map(t => t.resolved_at.slice(0, 7)))].sort().slice(-12);
  const el = $('#c-res');
  if (!months.length) el.innerHTML = '<p class="muted">No resolved tickets yet.</p>';
  else chart(el, { labels: months, series: [{ name: 'Median resolution (days)', values: months.map(m => { const r = list.filter(t => t.resolved_at?.startsWith(m)).map(t => durH(t.created_at, t.resolved_at) / 24); return pct(r, 50); }) }], fmt: v => v.toFixed(1) });
}

async function health(view, params) {
  const env = params.get('env') || 'production', range = params.get('range') || '24h', service = params.get('service') || '';
  view.innerHTML = '<h1>Engineering health</h1><p class="muted">Loading telemetry…</p>';
  const h = await api(`/api/health?${new URLSearchParams({ env, range, service })}`);
  const ax = h.axiom;
  const off = (name, owns, s) => `<div class="card"><h2>${name}</h2><p class="muted small">${owns}</p><p class="notice">${esc(s.reason)}</p></div>`;
  let axHtml;
  if (!ax?.connected) axHtml = off('Axiom — application traces and logs', 'Golden signals for backend services.', ax || { reason: h.error });
  else {
    const svcOpts = ax.services.map(s => s.service).filter(Boolean);
    axHtml = `<div class="card"><h2>Axiom — ${esc(env)}${service ? ` / ${esc(service)}` : ' / all services'} (${esc(range)})</h2>
      <p class="small muted">Server spans, OPTIONS excluded. Error = span error flag or HTTP status ≥ 400 (same definition as the existing Axiom APM dashboards).</p>
      <div class="filters"><select id="svc"><option value="">All services</option>${svcOpts.map(s => `<option ${s === service ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
      <div class="grid2"><div><h3>Latency (ms)</h3><div id="c-lat"></div></div><div><h3>Error rate (%)</h3><div id="c-err"></div></div><div><h3>Requests</h3><div id="c-req"></div></div></div>
      <h3>By service</h3><div class="scroll"><table><tr><th>Service</th><th class="num">Requests</th><th class="num">Failed</th><th class="num">Error rate</th><th class="num">p50</th><th class="num">p90</th><th class="num">p95</th><th class="num">p99</th></tr>
      ${ax.services.map(s => `<tr><td>${esc(s.service)}</td><td class="num">${s.requests}</td><td class="num">${s.errors}</td><td class="num">${s.requests ? ((100 * s.errors) / s.requests).toFixed(2) : '—'}%</td>${['p50', 'p90', 'p95', 'p99'].map(p => `<td class="num">${s[p] == null ? '—' : s[p].toFixed(0)} ms</td>`).join('')}</tr>`).join('')}</table></div>
      <h3>SLOs and error budget</h3>${ax.slos.length ? ax.slos.map(s => `<div>${esc(s.service)}: target ${s.availabilityTarget}% over ${s.windowDays} d — measured ${s.availability == null ? 'no traffic' : `${s.availability.toFixed(3)}%`}, budget consumed ${s.budget_consumed_pct == null ? '—' : `${s.budget_consumed_pct.toFixed(0)}%`}</div>`).join('') : '<p class="notice">No SLO is configured for this environment, so availability compliance and error-budget burn are not computed. Add agreed SLOs to <code>config.json → slos</code>.</p>'}
    </div>`;
  }
  view.innerHTML = `<h1>Engineering health</h1>
    <div class="filters">
      <select id="env">${['production', 'staging', 'development'].map(e => `<option ${e === env ? 'selected' : ''}>${e}</option>`).join('')}</select>
      <select id="range">${['1h', '24h', '7d', '30d'].map(r => `<option ${r === range ? 'selected' : ''}>${r}</option>`).join('')}</select>
      <span class="muted small">Ticket data does not depend on telemetry; disconnected sources are shown as disconnected, never as zero.</span>
    </div>
    ${axHtml}
    <div class="grid2">${off('New Relic: Kubernetes and infrastructure', 'Cluster/node metrics and cluster alerts.', h.newrelic)}${off('CloudWatch: AWS-native telemetry', 'AWS service metrics.', h.cloudwatch)}</div>
    <div class="card"><h2>Incidents linked to tickets</h2>${(() => { const inc = issues().filter(t => /outage|incident/i.test(`${t.type} ${t.labels.join(' ')} ${t.title}`)); return inc.length ? `<ul class="plain">${inc.map(t => `<li><a href="#/ticket/${encodeURIComponent(t.id)}">${esc(ref(t))}</a> ${esc(t.title)} ${statusBadge(t)}</li>`).join('')}</ul><p class="small muted">Matched by the Outage label/type or "outage"/"incident" in the title.</p>` : '<p class="muted">No outage/incident tickets in scope.</p>'; })()}</div>`;
  const go = (k, v) => { const p = new URLSearchParams({ env, range, service }); p.set(k, v); if (k === 'env') p.delete('service'); location.hash = `#/health?${p}`; };
  $('#env').addEventListener('change', e => go('env', e.target.value));
  $('#range').addEventListener('change', e => go('range', e.target.value));
  $('#svc')?.addEventListener('change', e => go('service', e.target.value));
  if (ax?.connected) {
    const labels = ax.series.map(r => new Date(r._time).toLocaleString(undefined, range === '1h' || range === '24h' ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit' }));
    chart($('#c-lat'), { labels, series: ['p50', 'p95', 'p99'].map(p => ({ name: p, values: ax.series.map(r => r[p]) })), fmt: v => `${Math.round(v)}` });
    chart($('#c-err'), { labels, series: [{ name: 'Error rate %', values: ax.series.map(r => (r.requests ? (100 * r.errors) / r.requests : null)) }], fmt: v => v.toFixed(1) });
    chart($('#c-req'), { type: 'bar', labels, series: [{ name: 'Requests', values: ax.series.map(r => r.requests) }] });
  }
}

async function syncs(view) {
  const list = await api('/api/syncs');
  view.innerHTML = `<h1>Synchronization</h1>
    <p class="muted small">Sources: GitHub organization <code>ilmiya</code> (all repositories discovered automatically; issues authored by ${esc(data.config.people.me)}). Incremental syncs fetch everything updated since the previous sync's cursor; a full sweep runs at least weekly and is the only run allowed to flag tickets as missing at source (never deleted or closed).</p>
    <p><button id="full">Run full re-sync</button></p>
    <div class="scroll"><table><tr><th>#</th><th>Started</th><th>Finished</th><th>Trigger</th><th>Mode</th><th>Status</th><th>Stats</th><th>Errors</th><th>Policy version</th></tr>
    ${list.map(s => `<tr><td>${s.id}</td><td class="nowrap">${fmtTime(s.started_at)}</td><td class="nowrap">${fmtTime(s.finished_at)}</td><td>${esc(s.trigger)}</td><td>${esc(s.mode)}</td><td><span class="b ${s.status === 'success' ? 'good' : s.status === 'running' ? 'warning' : 'critical'}">${esc(s.status)}</span></td><td class="small">${esc(s.stats)}</td><td class="small">${esc(s.errors === '[]' ? '' : s.errors)}</td><td>${esc(s.policy_version)}</td></tr>`).join('')}</table></div>`;
  $('#full').addEventListener('click', async e => {
    e.target.disabled = true; e.target.textContent = 'Running…';
    try { await api("/api/sync?full=1", { method: "POST" }); } catch (err) { $("#banner").innerHTML = `<p class="banner bad">Full re-sync failed: ${esc(err.message)}</p>`; }
    await load(); route();
  });
}

// ---------- router ----------
async function route() {
  const [path, qs] = (location.hash.slice(1) || '/overview').split('?');
  const params = new URLSearchParams(qs);
  document.querySelectorAll('.top nav a').forEach(a => a.classList.toggle('active', path.startsWith(a.getAttribute('href').slice(1)) || (path.startsWith('/ticket/') && a.getAttribute('href') === '#/tickets')));
  const view = $('#view');
  hideTip();
  try {
    if (path === '/overview') overview(view);
    else if (path === '/tickets') tickets(view, params);
    else if (path.startsWith('/ticket/')) await detail(view, decodeURIComponent(path.slice(8)));
    else if (path === '/progress') await progress(view, params);
    else if (path === '/sla') sla(view, params);
    else if (path === '/health') await health(view, params);
    else if (path === '/syncs') await syncs(view);
    else view.innerHTML = '<p>Not found.</p>';
  } catch (err) {
    view.innerHTML = `<p class="banner bad">Failed to load: ${esc(err.message)}</p>`;
  }
}

addEventListener('hashchange', route);
load().then(route).catch(err => { $('#view').innerHTML = `<p class="banner bad">Cannot load ticket data: ${esc(err.message)}</p>`; });
