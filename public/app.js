// All numbers on this page are computed from synced source data returned by /api/*.
const DAY = 864e5;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = u => (/^https:\/\/github\.com\//.test(u || '') ? u : '#');
const fmtDate = s => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const fmtTime = s => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const ago = s => { if (!s) return 'never'; const h = (Date.now() - Date.parse(s)) / 3600e3; return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`; };
const hours = h => (h == null ? '—' : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`);
const ref = t => `${t.repo.split('/')[1]}#${t.number}`;
const tlink = t => `#/ticket/${encodeURIComponent(t.id)}`;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

// ---------- icons (inline SVG, no external assets) ----------
const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  pulse: '<path d="M22 12h-4l-3 8L9 4l-3 8H2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  trash: '<path d="M3 6h18M9 6V4h6v2M6 6l1 14h10l1-14"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6z"/>',
  flag: '<path d="M4 22V4M4 4h13l-2 4 2 4H4"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-12 8"/>',
};
const ic = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

let data, changesCache, hiddenCount = 0;
const load = async () => {
  const [d, hidden] = await Promise.all([api('/api/tickets'), api('/api/hidden')]);
  data = d; hiddenCount = hidden.length; changesCache = null;
  renderBanner(); renderNav();
};
const changes = async () => (changesCache ??= await api('/api/changes'));
const issues = () => data.tickets.filter(t => t.kind === 'issue');

// ---------- theme ----------
const storage = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const isDark = () => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
function renderTheme() { $('#theme').innerHTML = `${ic(isDark() ? 'sun' : 'moon')}<span class="txt">${isDark() ? 'Light mode' : 'Dark mode'}</span>`; }
if (storage.get('theme')) document.documentElement.dataset.theme = storage.get('theme');
$('#theme').addEventListener('click', () => { const next = isDark() ? 'light' : 'dark'; document.documentElement.dataset.theme = next; storage.set('theme', next); renderTheme(); route(); });
renderTheme();

// ---------- navigation ----------
const NAV = [
  ['Tracking', [['#/overview', 'Overview', 'grid'], ['#/tickets', 'Tickets', 'list', () => issues().filter(t => t.state === 'OPEN').length], ['#/progress', 'Progress', 'trend']]],
  ['Quality', [['#/sla', 'SLA', 'clock'], ['#/health', 'Health', 'pulse']]],
  ['Admin', [['#/syncs', 'Syncs', 'refresh'], ['#/deleted', 'Deleted', 'trash', () => hiddenCount]]],
];
function renderNav() {
  const path = (location.hash.slice(1) || '/overview').split('?')[0];
  $('#nav').innerHTML = NAV.map(([label, items]) => `<div class="label">${label}</div>${items.map(([href, text, icon, count]) => {
    const active = path === href.slice(1) || (path.startsWith('/ticket/') && href === '#/tickets');
    return `<a href="${href}" class="${active ? 'active' : ''}" ${active ? 'aria-current="page"' : ''} title="${text}">${ic(icon)}<span class="txt">${text}</span>${count && data ? `<span class="count">${count()}</span>` : ''}</a>`;
  }).join('')}`).join('');
}
const crumbs = parts => { $('#crumbs').innerHTML = parts.map(([t, h], i) => (i === parts.length - 1 ? `<b>${esc(t)}</b>` : `<a href="${h}">${esc(t)}</a><span>/</span>`)).join(''); };
const pageHead = (title, sub, actions = '') => `<div class="page-head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
const cardHead = (title, sub = '', right = '') => `<div class="card-head"><h2>${title}</h2>${right ? `<div class="right">${right}</div>` : ''}${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
const notice = html => `<div class="notice">${ic('info')}<div>${html}</div></div>`;
const empty = (msg, icon = 'inbox') => `<div class="empty">${ic(icon)}${msg}</div>`;
const table = (head, body) => `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;

// ---------- badges ----------
const SEV_CLS = { critical: 'critical', high: 'high', normal: '', unknown: '' };
const sevBadge = (t, always = false) => {
  const title = `priority ${t.priority ?? 'none'} from ${t.priority_source === 'manual' ? `manual edit (source: ${t.source.priority ?? 'none'})` : t.priority_source ?? 'no source field'}`;
  if (!t.priority && !always) return `<span class="muted" title="${esc(title)}">—</span>`;
  return `<span class="pill ${SEV_CLS[t.severity]}" title="${esc(title)}">${esc(t.priority ?? 'No priority')}${t.priority_source === 'manual' ? ' ✎' : ''}</span>`;
};
const SLA_B = { breached: ['critical', 'SLA breached'], at_risk: ['warning', 'SLA at risk'], ok: ['good', 'Within SLA'], met: ['good', 'SLA met'], 'n/a': ['', 'SLA n/a'], not_configured: ['', 'Not configured'] };
const slaBadge = t => `<span class="pill ${SLA_B[t.sla.state][0]}" title="${t.sla.state === 'not_configured' ? 'Policy not configured' : esc(t.sla.policy ?? '')}">${SLA_B[t.sla.state][1]}</span>`;
const flags = t => [
  t.blocked && '<span class="pill warning">Blocked</span>',
  t.overdue && `<span class="pill critical" title="${esc(t.overdue_reason)}">Overdue</span>`,
  t.stale && `<span class="pill" title="no source activity for ${t.inactive_days} days">${t.inactive_days}d idle</span>`,
  t.reopened && '<span class="pill">Reopened</span>',
  t.missing_since && '<span class="pill critical" title="not returned by the last complete full sync">Missing at source</span>',
].filter(Boolean).join('');
const FIX = { production: 'good', staging: 'warning', dev: 'info' };
const fixTitle = t => t.fix.evidence.map(e => `${e.repo.split('/')[1]}@${e.sha} ${e.subject}\n   on: ${Object.entries(e.branches).filter(([, v]) => v).map(([b]) => b).join(', ') || 'no environment branch'}`).join('\n');
const fixBadge = t => (t.fix.manual
  ? `<span class="pill ${FIX[t.fix.env] ?? 'manual'}" title="manual edit; branch history says: ${esc(t.fix.computed_env ?? 'no environment')}">${esc(t.fix.env ?? 'none')} ✎</span>`
  : t.fix.env ? `<span class="pill ${FIX[t.fix.env]}" title="${esc(fixTitle(t))}">${esc(t.fix.env)}</span>`
  : `<span class="muted small" title="${esc(fixTitle(t))}">${esc(t.fixed_in === 'no fix evidence' ? '—' : t.fixed_in)}</span>`);
const STATUS_CLS = s => (['done', 'merged'].includes(s) ? 'good' : s === 'blocked' ? 'warning' : /progress|review/.test(s) ? 'info' : '');
const SOURCE_TITLE = { project: 'from the GitHub Project Status field', derived: 'derived from state, labels, assignees and linked PRs', manual: 'set manually in the tracker' };
const statusBadge = t => `<span class="pill ${STATUS_CLS(t.status)}" title="Status ${SOURCE_TITLE[t.status_source]}">${esc(t.status)}${t.status_source === 'manual' ? ' ✎' : ''}</span>`;
const initials = login => login.replace(/[^a-zA-Z]/g, ' ').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
const person = login => `<span class="person"><span class="avatar" aria-hidden="true">${esc(initials(login))}</span>${esc(login)}</span>`;
const people = list => (list.length ? list.map(person).join('<br>') : '<span class="muted">Unassigned</span>');

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
  fix_prod: { label: 'Open, fix on production', f: t => t.state === 'OPEN' && t.fix.env === 'production' },
  fix_staging: { label: 'Open, fix on staging', f: t => t.state === 'OPEN' && t.fix.env === 'staging' },
  fix_dev: { label: 'Open, fix only on dev', f: t => t.state === 'OPEN' && t.fix.env === 'dev' },
  fix_none: { label: 'Open, no fix yet', f: t => t.state === 'OPEN' && !t.fix.env },
  manual: { label: 'Edited manually', f: t => !!t.override },
};
const GROUPS = [
  ['Workload', 'inbox', 'work', ['open', 'in_progress', 'unassigned', 'created_today', 'created_week', 'manual']],
  ['Delivery', 'check', 'done', ['done_today', 'done_week', 'fix_prod', 'fix_staging', 'fix_dev']],
  ['Risk', 'alert', 'risk', ['crit_high', 'blocked', 'overdue', 'sla_risk', 'stale', 'reopened']],
];

// ---------- banner / sync ----------
function renderBanner() {
  const { lastSync: l, lastSuccess: ok } = data;
  let cls = '', msg = '';
  if (!ok) [cls, msg] = ['bad', 'No successful sync yet. Nothing below can be treated as current.'];
  else if (l && l.id !== ok.id && l.status !== 'running') [cls, msg] = ['bad', `Latest sync #${l.id} (${fmtTime(l.started_at)}) was ${l.status.toUpperCase()}: ${JSON.parse(l.errors || '[]').map(e => `${e.scope}: ${e.error}`).join('; ')}. Data shown is from the last successful sync at ${fmtTime(ok.started_at)}.`];
  else if (l?.status === 'running') [cls, msg] = ['warn', `Sync #${l.id} is running (started ${fmtTime(l.started_at)}).`];
  else if (Date.now() - Date.parse(ok.started_at) > 26 * 3600e3) [cls, msg] = ['warn', `Data is stale: last successful sync was ${ago(ok.started_at)} (${fmtTime(ok.started_at)}).`];
  const pill = $('#sync-age');
  pill.className = `sync-pill ${cls}`;
  pill.textContent = ok ? `Synced ${ago(ok.started_at)}` : 'Never synced';
  pill.title = ok ? `Last successful sync: ${fmtTime(ok.started_at)}` : '';
  $('#banner').innerHTML = msg ? alertBox(cls, msg) : '';
}
const alertBox = (cls, msg) => `<p class="alert ${cls}">${ic(cls === 'ok' ? 'check' : 'alert')}<span>${esc(msg)}</span></p>`;

const syncBtn = $('#sync-now');
const syncLabel = text => { syncBtn.innerHTML = `${ic('refresh')}${text}`; };
syncLabel('Sync now');
syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true; syncLabel('Syncing…');
  try {
    const r = await api('/api/sync', { method: 'POST' });
    await load();
    $('#banner').insertAdjacentHTML('beforeend', alertBox(r.status === 'success' ? 'ok' : 'bad', r.skipped ? `Sync skipped: ${r.skipped}` : `Sync #${r.id} ${r.status}: ${r.stats.fetched} fetched, ${r.stats.new} new, ${r.stats.changed} changed${r.errors.length ? ` — errors: ${r.errors.map(x => x.error).join('; ')}` : ''}`));
    route();
  } catch (err) {
    $('#banner').innerHTML = alertBox('bad', `Sync request failed: ${err.message}`);
  } finally { syncBtn.disabled = false; syncLabel('Sync now'); }
});

// ---------- charts (single y-axis, ≤3 series, hover tooltip, table fallback) ----------
const tip = $('#tip');
const showTip = (ev, html) => { tip.innerHTML = html; tip.hidden = false; tip.style.left = `${Math.min(ev.clientX + 14, innerWidth - 230)}px`; tip.style.top = `${ev.clientY + 14}px`; };
const hideTip = () => { tip.hidden = true; };
const niceMax = v => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p / (v / p > 5 ? 2 : 1)) * p * (v / p > 5 ? 2 : 1); };
const legend = series => (series.length > 1 ? `<div class="legend">${series.map((s, i) => `<span><span class="sw s${i + 1}"></span>${esc(s.name)}</span>`).join('')}</div>` : '');
const dataTable = (labels, series, fmt) => `<details><summary>Show data table</summary>${table(`<th></th>${series.map(s => `<th class="num">${esc(s.name)}</th>`).join('')}`, labels.map((l, i) => `<tr><td>${esc(l)}</td>${series.map(s => `<td class="num">${s.values[i] == null ? '—' : esc(fmt(s.values[i]))}</td>`).join('')}</tr>`).join(''))}</details>`;

function chart(el, { labels, series, type = 'line', fmt = v => String(Math.round(v)) }) {
  const W = Math.max(320, el.clientWidth || 600), H = 230, m = { l: 44, r: 12, t: 12, b: 26 };
  const max = niceMax(Math.max(0, ...series.flatMap(s => s.values.filter(v => v != null))));
  const pw = W - m.l - m.r, ph = H - m.t - m.b, n = labels.length;
  const y = v => m.t + ph - (v / max) * ph;
  const band = pw / n, x = i => (type === 'bar' ? m.l + band * i + band / 2 : m.l + (n < 2 ? pw / 2 : (i * pw) / (n - 1)));
  let svg = [0, 0.25, 0.5, 0.75, 1].map(f => `<line class="gl" x1="${m.l}" x2="${W - m.r}" y1="${y(max * f)}" y2="${y(max * f)}"/><text x="${m.l - 8}" y="${y(max * f) + 4}" text-anchor="end">${esc(fmt(max * f))}</text>`).join('');
  svg += `<line class="base" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
  [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i && v >= 0).forEach(i => (svg += `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 && type !== 'bar' ? 'start' : i === n - 1 && type !== 'bar' ? 'end' : 'middle'}">${esc(labels[i])}</text>`));
  if (type === 'bar') {
    const bw = Math.max(2, (band - 6) / series.length);
    series.forEach((s, k) => s.values.forEach((v, i) => {
      if (!v) return;
      const bx = m.l + band * i + 3 + k * bw, h = y(0) - y(v), r = Math.min(4, bw / 2, h);
      svg += `<path class="bar s${k + 1}" d="M${bx},${y(0)} V${y(v) + r} q0,-${r} ${r},-${r} H${bx + bw - r} q${r},0 ${r},${r} V${y(0)} Z"/>`;
    }));
  } else {
    series.forEach((s, k) => {
      const d = s.values.map((v, i) => (v == null ? '' : `${i && s.values[i - 1] != null ? 'L' : 'M'}${x(i)},${y(v)}`)).join('');
      if (series.length === 1 && s.values.every(v => v != null)) svg += `<path class="area" d="${d} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z"/>`;
      svg += `<path class="ln s${k + 1}" d="${d}"/>`;
      if (n <= 24) svg += s.values.map((v, i) => (v == null ? '' : `<circle class="dot s${k + 1}" r="4" cx="${x(i)}" cy="${y(v)}"/>`)).join('');
    });
  }
  svg += `<line class="xh" y1="${m.t}" y2="${y(0)}" visibility="hidden"/><g class="dots"></g><rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="transparent" class="hit"/>`;
  el.innerHTML = `${legend(series)}<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map(s => s.name).join(', '))}">${svg}</svg></div>${dataTable(labels, series, fmt)}`;
  const s = el.querySelector('svg'), xh = s.querySelector('.xh'), dots = s.querySelector('.dots');
  s.querySelector('.hit').addEventListener('mousemove', ev => {
    const p = s.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY;
    const px = p.matrixTransform(s.getScreenCTM().inverse()).x;
    const i = Math.max(0, Math.min(n - 1, type === 'bar' ? Math.floor((px - m.l) / band) : Math.round(((px - m.l) / pw) * (n - 1))));
    xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
    dots.innerHTML = type === 'line' ? series.map((se, k) => (se.values[i] == null ? '' : `<circle class="dot s${k + 1}" r="4.5" cx="${x(i)}" cy="${y(se.values[i])}"/>`)).join('') : '';
    showTip(ev, `<b>${esc(labels[i])}</b><br>${series.map((se, k) => `<span class="sw s${k + 1}"></span>${esc(se.name)}: <b>${se.values[i] == null ? '—' : esc(fmt(se.values[i]))}</b>`).join('<br>')}`);
  });
  s.querySelector('.hit').addEventListener('mouseleave', () => { hideTip(); xh.setAttribute('visibility', 'hidden'); dots.innerHTML = ''; });
}

// Open count at end of each day from created/closed timestamps (reopen cycles are not reconstructed).
const openAt = (list, ms) => list.filter(t => Date.parse(t.created_at) <= ms && (!t.closed_at || Date.parse(t.closed_at) > ms)).length;

// ---------- overview ----------
function overview(view) {
  crumbs([['Overview']]);
  const list = issues();
  const open = list.filter(t => t.state === 'OPEN');
  const days = Array.from({ length: 60 }, (_, i) => startOfToday() + DAY - (59 - i) * DAY - 1);
  const weeks = Array.from({ length: 12 }, (_, i) => startOfToday() + DAY - (11 - i) * 7 * DAY);
  const inWeek = (s, end) => s && Date.parse(s) < end && Date.parse(s) >= end - 7 * DAY;
  const groups = GROUPS.map(([name, icon, cls, keys]) => `<section class="kpi-group"><h2>${ic(icon)}${name}</h2><div class="tiles">${keys.map(k => {
    const v = list.filter(PRESETS[k].f).length;
    return `<a class="tile ${cls} ${v ? (cls === 'risk' ? 'alarm' : '') : 'zero'}" href="#/tickets?preset=${k}"><span class="v">${v}</span><span class="l">${esc(PRESETS[k].label)}</span></a>`;
  }).join('')}</div></section>`).join('');
  const segs = [['production', 's1', 'fix_prod'], ['staging', 's2', 'fix_staging'], ['dev', 's3', 'fix_dev'], ['no fix yet', 'none', 'fix_none']].map(([name, cls, preset]) => ({ name, cls, preset, n: open.filter(PRESETS[preset].f).length }));
  let acc = 0;
  const bar = open.length ? `<svg viewBox="0 0 1000 30" preserveAspectRatio="none" role="img" aria-label="Open issues by fix environment">${segs.filter(s => s.n).map(s => { const w = (1000 * s.n) / open.length, r = `<a href="#/tickets?preset=${s.preset}"><rect class="seg ${s.cls}" x="${acc}" y="0" width="${w}" height="30" rx="6"><title>${s.name}: ${s.n}</title></rect></a>`; acc += w; return r; }).join('')}</svg>` : '';
  view.innerHTML = `${pageHead('Overview', `Issues created by <b>${esc(data.config.people.me)}</b> across ${(n => `${n} ${n === 1 ? 'repository' : 'repositories'}`)(new Set(list.map(t => t.repo)).size)} · ${list.length} tracked · ${open.length} open. Every number opens the matching tickets.`)}
    ${groups}
    <div class="card">${cardHead('Where the fixes are', `Open issues by the highest environment branch that contains every fix change (from commit history). ${list.filter(t => !t.priority).length} of ${list.length} issues have no readable priority.`)}
      <div class="pipeline">${bar || empty('No open issues')}</div>
      <div class="pipe-legend">${segs.map(s => `<a href="#/tickets?preset=${s.preset}"><span class="sw ${s.cls}"></span>${esc(s.name)}<b>${s.n}</b></a>`).join('')}</div></div>
    <div class="grid2">
      <div class="card">${cardHead('Open issues over time', 'End of day, last 60 days. Approximate: reconstructed from created/closed timestamps.')}<div id="c-open"></div></div>
      <div class="card">${cardHead('Created vs completed', 'Per week (labelled by week start), last 12 weeks')}<div id="c-weekly"></div></div>
    </div>
    <div class="card">${cardHead('Repositories and types', 'Open now vs 7 days ago')}<div id="trend"></div></div>`;
  chart($('#c-open'), { labels: days.map(d => fmtDate(new Date(d).toISOString())), series: [{ name: 'Open issues', values: days.map(d => openAt(list, d)) }] });
  chart($('#c-weekly'), { type: 'bar', labels: weeks.map(w => new Date(w - 7 * DAY).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })), series: [{ name: 'Created', values: weeks.map(w => list.filter(t => inWeek(t.created_at, w)).length) }, { name: 'Completed', values: weeks.map(w => list.filter(t => inWeek(t.resolved_at, w)).length) }] });
  $('#trend').innerHTML = trendTable(list);
}

function trendTable(list) {
  const weekAgo = Date.now() - 7 * DAY;
  const rows = [...['repo', 'type'].flatMap(dim => [...new Set(list.map(t => t[dim]))].map(v => {
    const g = list.filter(t => t[dim] === v);
    const now = g.filter(t => t.state === 'OPEN').length, before = openAt(g, weekAgo);
    return { dim, v, now, before, created: g.filter(t => within(t.created_at, weekAgo)).length, done: g.filter(t => within(t.resolved_at, weekAgo)).length };
  }))].sort((a, b) => b.now - b.before - (a.now - a.before));
  return table('<th>Group</th><th class="num">Open 7 d ago</th><th class="num">Open now</th><th class="num">Change</th><th class="num">Created</th><th class="num">Completed</th><th>Direction</th>',
    rows.map(r => { const d = r.now - r.before; return `<tr><td><span class="muted small">${esc(r.dim)}</span><br>${esc(r.dim === 'repo' ? r.v.split('/')[1] : r.v)}</td><td class="num">${r.before}</td><td class="num">${r.now}</td><td class="num">${d > 0 ? '+' : ''}${d}</td><td class="num">${r.created}</td><td class="num">${r.done}</td><td>${d > 0 ? '<span class="pill high">Backlog growing</span>' : d < 0 ? '<span class="pill good">Improving</span>' : '<span class="pill">No change</span>'}</td></tr>`; }).join(''));
}

// ---------- tickets ----------
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
  crumbs([['Tickets']]);
  const p = Object.fromEntries(params);
  const all = data.tickets;
  const opts = (key, values, label, show = v => v) => `<select data-k="${key}" aria-label="${label}"><option value="">${label}: all</option>${[...new Set(values)].filter(Boolean).sort().map(v => `<option value="${esc(v)}" ${p[key] === v ? 'selected' : ''}>${esc(show(v))}</option>`).join('')}</select>`;
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
  const filtered = Object.keys(p).some(k => !['sort', 'page'].includes(k));
  view.innerHTML = `${pageHead('Tickets', 'Every tracked ticket, with source status, where its fix is, SLA and risk flags. Filters combine.')}
    <div class="filterbar">
      <div class="row">
        <div class="search">${ic('search')}<input type="search" data-k="q" placeholder="Search by ID, title or label…" value="${esc(p.q)}" aria-label="Search"></div>
        <select data-k="preset" aria-label="Metric"><option value="">Metric: all</option>${Object.entries(PRESETS).map(([k, v]) => `<option value="${k}" ${p.preset === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
      </div>
      <div class="row">
        ${new Set(all.map(t => t.kind)).size > 1 ? opts('kind', all.map(t => t.kind), 'Kind') : ''}
        ${opts('repo', all.map(t => t.repo), 'Repo', v => v.split('/')[1])}
        ${opts('assignee', [...all.flatMap(t => t.assignees), '(unassigned)'], 'Assignee')}
        ${opts('status', all.map(t => t.status), 'Status')}
        ${opts('severity', all.map(t => t.severity), 'Severity')}
        ${opts('type', all.map(t => t.type), 'Type')}
        ${opts('fixed_in', all.map(t => t.fixed_in), 'Fixed in')}
        ${opts('sla', all.map(t => t.sla.state), 'SLA')}
        <label class="inline">Created <input type="date" data-k="from" value="${esc(p.from)}" aria-label="Created from"></label>
        <label class="inline">to <input type="date" data-k="to" value="${esc(p.to)}" aria-label="Created to"></label>
      </div>
    </div>
    <div class="result-bar"><span><b>${list.length}</b> ticket${list.length === 1 ? '' : 's'}</span>
      ${p.preset && PRESETS[p.preset] ? `<span class="chip-link">${esc(PRESETS[p.preset].label)}</span>` : ''}
      ${filtered ? '<a href="#/tickets">Clear filters</a>' : ''}
      <div class="right"><select data-k="sort" aria-label="Sort">${[['severity', 'Severity'], ['oldest', 'Oldest open'], ['sla', 'SLA risk'], ['inactivity', 'Inactivity'], ['updated', 'Last update']].map(([v, l]) => `<option value="${v}" ${(p.sort || 'severity') === v ? 'selected' : ''}>Sort: ${l}</option>`).join('')}</select></div>
    </div>
    ${rows.length ? table('<th>Ticket</th><th>Priority</th><th>Status</th><th>Fixed in</th><th>Assignee</th><th class="num">Age</th><th>Last update</th><th>SLA</th><th>Flags</th><th></th>',
      rows.map(t => `<tr>
        <td class="tcell"><a class="id" href="${tlink(t)}">${esc(ref(t))}</a><a class="title" href="${tlink(t)}">${esc(t.title)}</a><span class="meta">${esc(t.type)} · opened ${fmtDate(t.created_at)}${t.labels.length ? ` · ${esc(t.labels.join(', '))}` : ''}</span></td>
        <td>${sevBadge(t)}</td><td>${statusBadge(t)}</td><td>${fixBadge(t)}</td><td>${people(t.assignees)}</td>
        <td class="num nowrap">${t.days_open} d</td>
        <td class="nowrap small"><span title="Last updated ${fmtTime(t.updated_at)}">${ago(t.updated_at)}</span><div class="muted" title="Last meaningful activity ${fmtTime(t.last_activity)}">activity ${ago(t.last_activity)}${t.history_approx ? ' <span class="tag approx">approx</span>' : ''}</div></td>
        <td>${slaBadge(t)}${t.sla.resolution?.due ? `<div class="small muted">due ${fmtDate(t.sla.resolution.due)}${t.sla.resolution.remaining_hours != null ? ` · ${hours(t.sla.resolution.remaining_hours)} left` : ''}</div>` : ''}</td>
        <td>${flags(t) || '<span class="muted">—</span>'}</td>
        <td><a class="icon-link" href="${esc(safeUrl(t.url))}" target="_blank" rel="noopener noreferrer" title="Open in GitHub" aria-label="Open ${esc(ref(t))} in GitHub">${ic('ext')}</a></td></tr>`).join(''))
      : `<div class="card">${empty('No tickets match these filters.', 'search')}</div>`}
    <div class="pager">${page > 0 ? `<button data-page="${page - 1}">← Previous</button>` : ''}<span class="muted small">Page ${page + 1} of ${Math.max(1, Math.ceil(list.length / per))}</span>${(page + 1) * per < list.length ? `<button data-page="${page + 1}">Next →</button>` : ''}</div>`;
  const update = (k, v) => { const np = new URLSearchParams(params); v ? np.set(k, v) : np.delete(k); if (k !== 'page') np.delete('page'); location.hash = `#/tickets?${np}`; };
  view.querySelectorAll('[data-k]').forEach(el => el.addEventListener(el.type === 'search' ? 'search' : 'change', () => update(el.dataset.k, el.value)));
  view.querySelector('input[type=search]').addEventListener('keydown', e => e.key === 'Enter' && update('q', e.target.value));
  view.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => update('page', b.dataset.page)));
}

// ---------- ticket detail ----------
function describeEvent(e) {
  const who = `<b>${esc(e.actor ?? 'someone')}</b>`;
  switch (e.t) {
    case 'comment': return `${who} commented${e.text ? `<div class="text">${esc(e.text)}</div>` : ''}`;
    case 'assigned': return `${who} assigned ${esc(e.who)}`;
    case 'unassigned': return `${who} unassigned ${esc(e.who)}`;
    case 'labeled': return `${who} added <span class="pill label">${esc(e.label)}</span>`;
    case 'unlabeled': return `${who} removed <span class="pill label">${esc(e.label)}</span>`;
    case 'closed': return `${who} closed this as ${esc((e.reason ?? 'closed').toLowerCase().replace('_', ' '))}`;
    case 'reopened': return `${who} reopened this`;
    case 'xref': case 'connected': return `${who} linked ${esc(e.kind === 'PullRequest' ? 'PR' : 'issue')} <a href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener noreferrer">${esc(e.ref)}</a> <span class="muted">(${esc(e.state)} when synced)</span>`;
    case 'milestoned': return `${who} set milestone <b>${esc(e.milestone)}</b>`;
    case 'demilestoned': return `${who} removed milestone ${esc(e.milestone)}`;
    case 'review': return `${who} reviewed (${esc(e.review)})`;
    default: return `${who} ${esc(e.t)}`;
  }
}

async function detail(view, id) {
  const { ticket: t, snapshots, changes: ch, choices } = await api(`/api/tickets/${encodeURIComponent(id)}`);
  crumbs([['Tickets', '#/tickets'], [ref(t)]]);
  const o = t.override ?? {};
  const pick = (k, label, values) => `<label>${label}<select data-o="${k}"><option value="">Automatic</option>${values.map(v => `<option ${o[k] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`;
  const tl = t.timeline;
  const comments = tl.filter(e => e.t === 'comment'), lastEv = tl.at(-1);
  const summary = [
    `${comments.length} comment(s) from ${new Set(comments.map(c => c.actor)).size} people`,
    `${t.linked_prs.length} linked PR(s) (${t.linked_prs.filter(p => p.state === 'MERGED').length} merged, ${t.linked_prs.filter(p => p.state === 'OPEN').length} open)`,
    t.work_started_at ? `work first observed ${fmtDate(t.work_started_at)} (first assignment or linked PR)` : 'no assignment or linked PR yet',
    lastEv ? `last source event: ${lastEv.t} by ${lastEv.actor ?? 'unknown'} ${ago(lastEv.at)}` : 'no source events after creation',
  ];
  const branches = data.config.fixEnvironments?.branches ?? [];
  const slaHtml = t.sla.state === 'not_configured' ? notice('<b>Policy not configured.</b> No SLA target applies to this ticket, so it is never classified as breached.')
    : `<dl class="kv"><dt>Policy</dt><dd>${esc(t.sla.policy)} · ${esc(t.sla.clock)} clock</dd><dt>Responded</dt><dd>${t.response_at ? `${fmtTime(t.response_at)} · by ${esc(t.response_by)}` : 'not yet'}</dd><dt>Resolved</dt><dd>${t.sla_resolved_at ? `${fmtTime(t.sla_resolved_at)} · ${esc(t.sla_resolved_by)}` : 'not yet'}</dd>${['response', 'resolution'].map(k => t.sla[k] ? `<dt>${k}</dt><dd>${slaBadge({ sla: t.sla[k] })} due ${fmtTime(t.sla[k].due)}${t.sla[k].breach_hours ? ` · breached by ${hours(t.sla[k].breach_hours)}` : ''}${t.sla[k].remaining_hours != null ? ` · ${hours(t.sla[k].remaining_hours)} left` : ''}</dd>` : '').join('')}</dl>`;
  const slaHistory = snapshots.map(s => ({ ...JSON.parse(s.data), at: s.captured_at, v: s.policy_version }));
  const send = async (body, done) => {
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(id)}/override`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
      await load();
      if (done) done(); else route();
    } catch (err) { $('#ov-msg').textContent = `Not saved: ${err.message}`; }
  };
  const fact = (k, v, s = '') => `<div class="fact"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  view.innerHTML = `<div class="ticket-head">
      <div class="ref"><span class="id">${esc(ref(t))}</span>${esc(t.repo)} · ${esc(t.type)} · opened by ${esc(t.author)} on ${fmtDate(t.created_at)}</div>
      <h1>${esc(t.title)}</h1>
      <div class="badges">${statusBadge(t)}${sevBadge(t, true)}${fixBadge(t).replace('class="muted small"', 'class="pill"')}${slaBadge(t)}${flags(t)}
        <div class="actions"><a href="${esc(safeUrl(t.url))}" target="_blank" rel="noopener noreferrer">${ic('ext')}Open in GitHub</a></div></div>
      <div class="legend-line"><span><span class="tag src">source</span> read from GitHub</span><span><span class="tag derived">derived</span> computed from source fields</span><span><span class="tag manual">manual</span> set by you</span><span><span class="tag approx">approx</span> history incomplete</span></div>
    </div>
    ${t.hidden ? `<p class="alert warn">${ic('alert')}<span>This ticket is deleted from the tracker. It is not shown or counted anywhere until you restore it.</span></p><br>` : ''}
    <div class="facts">
      ${fact('Days open', t.days_open, t.state === 'OPEN' ? 'still open' : `closed ${fmtDate(t.closed_at)}`)}
      ${fact('Last activity', ago(t.last_activity), fmtDate(t.last_activity))}
      ${fact('First response', t.response_at ? fmtDate(t.response_at) : '—', t.response_by ? `by ${t.response_by}` : 'no comment or fix commit yet')}
      ${fact('Work started', t.work_started_at ? fmtDate(t.work_started_at) : '—', 'assignment or linked PR')}
      ${fact('Fixed in', esc(t.fix.env ?? (t.fix.manual ? 'none' : '—')), t.fix.manual ? 'manual edit' : 'from branch history')}
    </div>
    <div class="detail">
      <div class="primary-col">
        <div class="card">${cardHead(`${ic('branch')} Fixed in <span class="tag ${t.fix.manual ? 'manual' : 'derived'}">${t.fix.manual ? 'manual' : 'derived'}</span>`, `Highest branch that contains every fix change (${esc(branches.map(([b, e]) => `${b} = ${e}`).join(', ') || 'not configured')}). Code present on the branch, not a verified deploy.`, fixBadge(t))}
          ${t.fix.evidence.length ? `${table(`<th>Fix change</th>${branches.map(([b, e]) => `<th>${esc(e)}<br><span class="small">${esc(b)}</span></th>`).join('')}`,
            t.fix.evidence.map(e => `<tr><td><a class="mono" href="https://github.com/${esc(e.repo)}/commit/${esc(e.sha)}" target="_blank" rel="noopener noreferrer">${esc(e.repo.split('/')[1])}@${esc(e.sha)}</a> ${esc(e.subject)}<div class="muted small">found via ${esc(e.via)}</div></td>${branches.map(([b]) => `<td>${e.branches[b] ? `<span class="pill good">present</span>${e.landed?.[b] ? `<div class="muted small nowrap">landed ${fmtDate(e.landed[b])}</div>` : ''}` : '<span class="pill">absent</span>'}</td>`).join('')}</tr>`).join(''))}<p class="muted small">Checked ${fmtTime(t.fix.checked_at)}.</p>`
            : notice('No fix evidence: no commit on an environment branch references this issue, and no "fixed" comment links a commit.')}
        </div>
        <div class="card">${cardHead(`Activity <span class="tag src">source</span>`, t.timeline_truncated ? 'Showing the first 100 events only.' : `${tl.length + 1} events`)}
          <ul class="timeline"><li class="ev-opened"><div class="what"><b>${esc(t.author)}</b> opened this issue</div><div class="when">${fmtTime(t.created_at)}</div></li>${tl.map(e => `<li class="ev-${esc(e.t)}"><div class="what">${describeEvent(e)}</div><div class="when">${fmtTime(e.at)}</div></li>`).join('')}</ul>
        </div>
        <div class="card">${cardHead(`Description <span class="tag src">source</span>`)}<pre class="body">${esc(t.body || '(empty)')}</pre></div>
        <div class="card">${cardHead('History', 'Changes observed between syncs (snapshot diff) and your manual edits (manual:…)')}
          ${ch.length ? table('<th>When</th><th>Field</th><th>From</th><th>To</th>', ch.map(c => `<tr><td class="nowrap small">${fmtTime(c.at)}</td><td>${c.field.startsWith('manual:') ? `<span class="tag manual">manual</span> ${esc(c.field.slice(7))}` : esc(c.field)}</td><td class="small">${esc(c.old ?? '∅')}</td><td class="small">${esc(c.new ?? '∅')}</td></tr>`).join('')) : empty('No changes observed since this ticket was first synced.', 'clock')}
        </div>
        <div class="card">${cardHead('SLA')}${slaHtml}
          <h3>Deadline history (per snapshot, with policy version)</h3>${table('<th>Captured</th><th>Policy version</th><th>Policy</th><th>Response due</th><th>Resolution due</th>', slaHistory.map(s => `<tr><td class="small">${fmtTime(s.at)}</td><td class="mono">${esc(s.v)}</td><td>${esc(s.sla_policy ?? 'not configured')}</td><td class="small">${fmtTime(s.response_due)}</td><td class="small">${fmtTime(s.resolution_due)}</td></tr>`).join(''))}
        </div>
      </div>
      <div class="aside">
        <div class="card">${cardHead(`${ic('pencil')} Tracker controls`, 'Tracker only; GitHub is not modified. Sync never overwrites these.')}
          <div class="form">
            <div class="source-says">Source says: state <b>${esc(t.source.state)}</b> · priority <b>${esc(t.source.priority ?? 'none')}</b> · fixed in <b>${esc(t.fix.manual ? t.fix.computed_env ?? 'no environment' : t.fix.env ?? 'no environment')}</b></div>
            ${pick('status', 'Status', choices.status)}${pick('priority', 'Priority', choices.priority)}${pick('fix_env', 'Fixed in', choices.fix_env)}
            <label>Note<textarea data-o="note" maxlength="2000" placeholder="Add a private note…">${esc(o.note ?? '')}</textarea></label>
            <div class="buttons">
              <button id="ov-save" class="primary">Save changes</button>
              ${t.override && (o.status || o.priority || o.fix_env || o.note) ? '<button id="ov-reset">Reset to automatic</button>' : ''}
            </div>
            <div class="buttons"><button id="ov-hide" class="${t.hidden ? '' : 'danger'}">${ic(t.hidden ? 'refresh' : 'trash')}${t.hidden ? 'Restore to tracker' : 'Delete from tracker'}</button></div>
            <div id="ov-msg" class="msg" role="status"></div>
          </div>
        </div>
        <div class="card">${cardHead(`Details <span class="tag src">source</span>`)}
          <dl class="kv">
            <dt>State</dt><dd>${esc(t.state)}${t.state_reason ? ` · ${esc(t.state_reason.toLowerCase())}` : ''}</dd>
            <dt>Assignees</dt><dd>${people(t.assignees)}</dd>
            <dt>Priority</dt><dd>${esc(t.priority ?? 'none')} ${t.priority_source ? `<span class="tag ${t.priority_source === 'manual' ? 'manual' : 'src'}">${esc(t.priority_source)}</span>` : ''}</dd>
            <dt>Labels</dt><dd>${t.labels.map(l => `<span class="pill label">${esc(l)}</span>`).join('') || '—'}</dd>
            <dt>Milestone</dt><dd>${esc(t.milestone ?? '—')}${t.milestone_due ? `<div class="muted small">due ${fmtDate(t.milestone_due)}</div>` : ''}</dd>
            <dt>Blocked by</dt><dd>${t.blocked_by.map(b => `${esc(b.ref)} (${esc(b.state)})`).join(', ') || '—'}</dd>
            <dt>Time open</dt><dd>${hours(t.durations.open_hours)}${t.durations.blocked_hours ? ` · blocked ${hours(t.durations.blocked_hours)}` : ''}</dd>
            <dt>Updated</dt><dd>${fmtTime(t.updated_at)}</dd>
            <dt>Last synced</dt><dd>${fmtTime(t.synced_at)}</dd>
          </dl>
          <h3>Summary of source activity <span class="tag derived">generated</span></h3><ul class="rows">${summary.map(s => `<li class="small">${esc(s)}</li>`).join('')}</ul>
          <h3>Linked pull requests</h3>${t.linked_prs.map(p => `<div><a href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener noreferrer">${esc(p.ref)}</a> <span class="pill">${esc(p.state)}</span></div>`).join('') || '<span class="muted small">None discovered</span>'}
        </div>
      </div>
    </div>`;
  $('#ov-save').addEventListener('click', () => send(Object.fromEntries([...view.querySelectorAll('[data-o]')].map(el => [el.dataset.o, el.value]))));
  $('#ov-reset')?.addEventListener('click', () => send({ status: null, priority: null, fix_env: null, note: null }));
  const hide = $('#ov-hide');
  hide.addEventListener('click', () => {
    if (t.hidden) return send({ hidden: false });
    if (hide.dataset.armed) return send({ hidden: true }, () => (location.hash = '#/deleted'));
    hide.dataset.armed = '1';
    hide.innerHTML = `${ic('trash')}Click again to delete`;
    setTimeout(() => { delete hide.dataset.armed; hide.innerHTML = `${ic('trash')}Delete from tracker`; }, 5000);
  });
}

// ---------- progress ----------
async function progress(view, params) {
  crumbs([['Progress']]);
  const day = params.get('day') || new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00`).getTime(), end = start + DAY;
  const [ch, syncList] = await Promise.all([changes(), api('/api/syncs')]);
  const list = issues(), byId = Object.fromEntries(data.tickets.map(t => [t.id, t]));
  const inDay = s => s && Date.parse(s) >= start && Date.parse(s) < end;
  const dayCh = ch.filter(c => inDay(c.at));
  const daySyncs = syncList.filter(s => inDay(s.started_at));
  const open = list.filter(t => t.state === 'OPEN');
  const row = (t, extra = '') => `<li><a class="id" href="${tlink(t)}">${esc(ref(t))}</a><a class="t" href="${tlink(t)}">${esc(t.title)}</a>${extra}</li>`;
  const section = (title, items, render, emptyMsg) => `<div class="card">${cardHead(title, '', `<span class="count-chip">${items.length}</span>`)}${items.length ? `<ul class="rows">${items.map(render).join('')}</ul>` : `<p class="muted small">${emptyMsg}</p>`}</div>`;
  const ppl = data.config.people;
  const attention = open.filter(t => (t.assignees.some(a => Object.values(ppl).includes(a)) || !t.assignees.length) && (t.blocked || t.overdue || ['critical', 'high'].includes(t.severity) || t.sla.state === 'breached'));
  const risks = [...open.filter(t => t.severity === 'critical'), ...open.filter(t => t.sla.state === 'breached'), ...open.filter(t => t.blocked && t.severity === 'high')].filter((t, i, a) => a.indexOf(t) === i);
  const changeRow = c => { const t = byId[c.ticket_id]; return t ? row(t, `<span class="extra">${c.field.startsWith('manual:') ? '<span class="tag manual">manual</span> ' : ''}${esc(c.field.replace('manual:', ''))}: ${esc(c.old ?? '∅')} → ${esc(c.new ?? '∅')}</span>`) : ''; };
  view.innerHTML = `${pageHead('Progress', 'Completed = source close time on that day. Changes = differences between consecutive sync snapshots, so a ticket counts once when it changes, never again on later days.', `<input type="date" id="day" value="${esc(day)}" aria-label="Day">`)}
    <div class="card">${cardHead(`Sync health · ${esc(day)}`)}${daySyncs.length ? daySyncs.map(s => `<div class="small">#${s.id} · ${esc(s.trigger)} · ${esc(s.mode)} · ${fmtTime(s.started_at)} <span class="pill ${s.status === 'success' ? 'good' : s.status === 'running' ? 'warning' : 'critical'}">${esc(s.status)}</span> ${s.errors && s.errors !== '[]' ? `<span class="muted">${esc(s.errors)}</span>` : ''}</div>`).join('') : notice('No sync ran on this day, so changes on this day may be missing (missing information, not "no change").')}</div>
    <div class="grid2">
      ${section('Completed', list.filter(t => inDay(t.resolved_at)), t => row(t, statusBadge(t)), 'Nothing was completed on this day.')}
      ${section('New tickets', list.filter(t => inDay(t.created_at)), t => row(t), 'None created on this day.')}
      ${section('Changes and manual edits', dayCh.filter(c => c.field !== '_new' && byId[c.ticket_id]), changeRow, 'No field changes observed (or no sync ran).')}
      ${section('Blocked', open.filter(t => t.blocked), t => row(t, `<span class="extra">${esc([t.labels.filter(l => /block/i.test(l)).map(l => `label "${l}"`).join(', '), t.blocked_by.filter(b => b.state === 'OPEN').map(b => `blocked by ${b.ref}`).join(', '), t.project_status && /block/i.test(t.project_status) ? 'project status' : '', t.status_source === 'manual' && t.status === 'blocked' ? 'set manually' : ''].filter(Boolean).join('; ') || 'blocked')}</span>`), 'Nothing is blocked.')}
      ${section('High-severity still open', open.filter(t => ['critical', 'high'].includes(t.severity)), t => row(t, sevBadge(t)), 'None. Note: most tickets have no readable priority.')}
      ${section(`No progress in ${data.config.staleDays}+ days`, open.filter(t => t.stale).sort(SORTS.inactivity), t => row(t, `<span class="extra">idle ${t.inactive_days} d</span>`), 'Every open ticket had recent activity.')}
      ${section('Approaching or past SLA', open.filter(t => ['at_risk', 'breached'].includes(t.sla.state)), t => row(t, slaBadge(t)), data.config.sla.policies.length ? 'None.' : 'SLA policies are not configured, so nothing can be at risk or breached.')}
      ${section('Biggest current risks', risks, t => row(t, `${sevBadge(t)}${slaBadge(t)}${flags(t)}`), 'No open critical, SLA-breached, or blocked high-severity tickets.')}
      ${section(`Needs attention · ${Object.values(ppl).join(' / ')} or unassigned`, attention, t => row(t, `${flags(t)}<span class="extra">${esc(t.assignees.join(', ') || 'unassigned')}</span>`), 'Nothing flagged.')}
    </div>
    <div class="card">${cardHead('Repositories and types', 'Improving or deteriorating: open now vs 7 days ago')}${trendTable(list)}</div>
    <div class="card">${cardHead('Activity feed', 'Last 30 days of observed changes and manual edits')}<ul class="timeline">${ch.slice(0, 200).map(c => { const t = byId[c.ticket_id]; return t ? `<li class="${c.field.startsWith('manual:') ? 'ev-manual' : ''}"><div class="what"><a class="mono" href="${tlink(t)}">${esc(ref(t))}</a> ${esc(t.title)} — ${c.field === '_new' ? `<b>${esc(c.new)}</b> (first seen)` : `${c.field.startsWith('manual:') ? '<span class="tag manual">manual</span> ' : ''}<b>${esc(c.field.replace('manual:', ''))}</b>: ${esc(c.old ?? '∅')} → ${esc(c.new ?? '∅')}`}</div><div class="when">${fmtTime(c.at)}</div></li>` : ''; }).join('') || `<li>${'No changes observed yet. The first sync is a baseline; changes appear from the second sync on.'}</li>`}</ul></div>`;
  $('#day').addEventListener('change', e => (location.hash = `#/progress?day=${e.target.value}`));
}

// ---------- SLA ----------
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
function sla(view, params) {
  crumbs([['SLA']]);
  const dim = params.get('by') || 'repo';
  const list = issues(), cfg = data.config;
  const durH = (a, b) => (Date.parse(b) - Date.parse(a)) / 3600e3;
  const stats = g => {
    const res = g.filter(t => t.sla_resolved_at).map(t => durH(t.created_at, t.sla_resolved_at));
    const resp = g.filter(t => t.response_at).map(t => durH(t.created_at, t.response_at));
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
  const all = stats(list);
  const policyHtml = cfg.sla.policies.length
    ? `${cfg.sla.owner ? notice(esc(cfg.sla.owner)) : ''}${table('<th>Policy</th><th>Applies to</th><th class="num">Response target</th><th class="num">Resolution target</th><th class="num">Tickets</th>', cfg.sla.policies.map(p => `<tr><td><b>${esc(p.id)}</b></td><td>${Object.keys(p.match || {}).length ? Object.entries(p.match).map(([k, v]) => `${esc(k)} = <b>${esc(v)}</b>`).join(', ') : 'every other ticket'}</td><td class="num">${hours(p.responseHours)}</td><td class="num">${hours(p.resolutionHours)}</td><td class="num">${list.filter(t => t.sla.policy === p.id).length}</td></tr>`).join(''))}`
    : notice('<b>Policy not configured.</b> No SLA targets have been agreed yet, so no ticket is classified as at risk or breached and compliance is not computed. The response and resolution times below are measured facts and do not depend on a policy. Add agreed targets to <code>config.json → sla.policies</code>.');
  const n20 = '<span class="muted" title="needs at least 20 resolved tickets">n&lt;20</span>';
  const resolvedDef = cfg.sla.resolvedWhen === 'production-or-closed' ? 'the last fix change landing on production (main), or the ticket closed as completed, whichever is first' : 'closed as completed';
  view.innerHTML = `${pageHead('SLA', `Clock: <b>${esc(cfg.sla.clock)}</b> time (24×7). Response = first comment by someone else or first fix commit · resolved = ${resolvedDef}.`, `<label class="small muted">Group by <select id="by">${['repo', 'severity', 'assignee', 'type'].map(d => `<option ${d === dim ? 'selected' : ''}>${d}</option>`).join('')}</select></label>`)}
    <div class="facts">
      <div class="fact"><div class="k">Compliance</div><div class="v">${all.compliance == null ? '—' : `${all.compliance.toFixed(0)}%`}</div><div class="s">${all.compliance == null ? 'policy not configured' : `${all.breaches} breaches`}</div></div>
      <div class="fact"><div class="k">Median resolution</div><div class="v">${hours(all.med)}</div><div class="s">${all.resolved} resolved (fix on prod or closed)</div></div>
      <div class="fact"><div class="k">Average resolution</div><div class="v">${hours(all.avg)}</div><div class="s">P90 ${all.p90 == null ? 'n<20' : hours(all.p90)}</div></div>
      <div class="fact"><div class="k">Median first response</div><div class="v">${hours(all.resp)}</div><div class="s">n=${all.respN} · comment or fix commit</div></div>
    </div>
    <div class="card">${cardHead('Policies', 'Each sync records the policy version it used (see a ticket\'s SLA history).')}${policyHtml}</div>
    <div class="card">${cardHead(`By ${esc(dim)}`)}${table('<th>Group</th><th class="num">Tickets</th><th class="num">Resolved</th><th class="num">Avg resolution</th><th class="num">Median</th><th class="num">P90</th><th class="num">P95</th><th class="num">Median first response</th><th class="num">Median to work start</th><th class="num">Compliance</th><th class="num">Breaches</th>',
      groups.map(([name, g]) => { const s = stats(g); return `<tr><td>${esc(dim === 'repo' && name !== 'All issues' ? name.split('/')[1] : name)}</td><td class="num">${s.n}</td><td class="num">${s.resolved}</td><td class="num">${hours(s.avg)}</td><td class="num">${hours(s.med)}</td><td class="num">${s.p90 == null ? n20 : hours(s.p90)}</td><td class="num">${s.p95 == null ? n20 : hours(s.p95)}</td><td class="num">${hours(s.resp)} <span class="muted small">n=${s.respN}</span></td><td class="num">${hours(s.start)}</td><td class="num">${s.compliance == null ? '<span class="muted">Not configured</span>' : `${s.compliance.toFixed(0)}%`}</td><td class="num">${s.compliance == null ? '—' : `${s.breaches} · ${hours(s.breachH)}`}</td></tr>`; }).join(''))}</div>
    <div class="card">${cardHead('Resolution time trend', 'Median days to resolution, by month of closure')}<div id="c-res"></div></div>`;
  $('#by').addEventListener('change', e => (location.hash = `#/sla?by=${e.target.value}`));
  const months = [...new Set(list.filter(t => t.sla_resolved_at).map(t => t.sla_resolved_at.slice(0, 7)))].sort().slice(-12);
  const el = $('#c-res');
  if (!months.length) el.innerHTML = empty('No resolved tickets yet.', 'clock');
  else chart(el, { labels: months, series: [{ name: 'Median resolution (days)', values: months.map(m => pct(list.filter(t => t.sla_resolved_at?.startsWith(m)).map(t => durH(t.created_at, t.sla_resolved_at) / 24), 50)) }], fmt: v => v.toFixed(1) });
}

// ---------- health ----------
async function health(view, params) {
  crumbs([['Health']]);
  const env = params.get('env') || 'production', range = params.get('range') || '24h', service = params.get('service') || '';
  view.innerHTML = `${pageHead('Engineering health', 'Loading telemetry…')}`;
  const h = await api(`/api/health?${new URLSearchParams({ env, range, service })}`);
  const ax = h.axiom;
  const off = (name, owns, s) => `<div class="card">${cardHead(`${ic('plug')} ${name}`, owns, '<span class="pill">Not connected</span>')}${notice(esc(s.reason))}</div>`;
  let axHtml;
  if (!ax?.connected) axHtml = off('Axiom', 'Application traces, logs and golden signals for backend services.', ax || { reason: h.error });
  else {
    const svcOpts = ax.services.map(s => s.service).filter(Boolean);
    axHtml = `<div class="card">${cardHead(`Axiom · ${esc(env)} · ${esc(service || 'all services')} · ${esc(range)}`, 'Server spans, OPTIONS excluded. Error = span error flag or HTTP status ≥ 400 (same definition as the Axiom APM dashboards).', `<span class="pill good">Connected</span><select id="svc" aria-label="Service"><option value="">All services</option>${svcOpts.map(s => `<option ${s === service ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>`)}
      <div class="grid2"><div><h3>Latency (ms)</h3><div id="c-lat"></div></div><div><h3>Error rate (%)</h3><div id="c-err"></div></div><div><h3>Requests</h3><div id="c-req"></div></div></div>
      <h3>By service</h3>${table('<th>Service</th><th class="num">Requests</th><th class="num">Failed</th><th class="num">Error rate</th><th class="num">p50</th><th class="num">p90</th><th class="num">p95</th><th class="num">p99</th>', ax.services.map(s => `<tr><td>${esc(s.service)}</td><td class="num">${s.requests}</td><td class="num">${s.errors}</td><td class="num">${s.requests ? ((100 * s.errors) / s.requests).toFixed(2) : '—'}%</td>${['p50', 'p90', 'p95', 'p99'].map(p => `<td class="num">${s[p] == null ? '—' : s[p].toFixed(0)} ms</td>`).join('')}</tr>`).join(''))}
      <h3>SLOs and error budget</h3>${ax.slos.length ? ax.slos.map(s => `<div>${esc(s.service)}: target ${s.availabilityTarget}% over ${s.windowDays} d · measured ${s.availability == null ? 'no traffic' : `${s.availability.toFixed(3)}%`} · budget consumed ${s.budget_consumed_pct == null ? '—' : `${s.budget_consumed_pct.toFixed(0)}%`}</div>`).join('') : notice('No SLO is configured for this environment, so availability compliance and error-budget burn are not computed. Add agreed SLOs to <code>config.json → slos</code>.')}
    </div>`;
  }
  const inc = issues().filter(t => /outage|incident/i.test(`${t.type} ${t.labels.join(' ')} ${t.title}`));
  view.innerHTML = `${pageHead('Engineering health', 'Ticket data does not depend on telemetry. Disconnected sources are shown as disconnected, never as zero.',
      `<select id="env" aria-label="Environment">${['production', 'staging', 'development'].map(e => `<option ${e === env ? 'selected' : ''}>${e}</option>`).join('')}</select><select id="range" aria-label="Time range">${['1h', '24h', '7d', '30d'].map(r => `<option ${r === range ? 'selected' : ''}>${r}</option>`).join('')}</select>`)}
    ${axHtml}
    <div class="grid2">${off('New Relic', 'Kubernetes and infrastructure metrics, cluster alerts.', h.newrelic)}${off('CloudWatch', 'AWS-native telemetry.', h.cloudwatch)}</div>
    <div class="card">${cardHead('Incidents linked to tickets', 'Outage label or type, or "outage"/"incident" in the title')}${inc.length ? `<ul class="rows">${inc.map(t => `<li><a class="id" href="${tlink(t)}">${esc(ref(t))}</a><a class="t" href="${tlink(t)}">${esc(t.title)}</a>${statusBadge(t)}${fixBadge(t)}</li>`).join('')}</ul>` : empty('No outage or incident tickets in scope.', 'check')}</div>`;
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

// ---------- deleted ----------
async function deleted(view) {
  crumbs([['Deleted']]);
  const list = await api('/api/hidden');
  view.innerHTML = `${pageHead('Deleted from tracker', 'Hidden from every page, metric and the daily summary. Sync keeps their data current but never brings them back; only Restore does (your edits are kept). GitHub is not modified.')}
    ${list.length ? table('<th>Ticket</th><th>Source state</th><th>Deleted</th><th></th>', list.map(t => `<tr><td class="tcell"><a class="id" href="${tlink(t)}">${esc(ref(t))}</a><a class="title" href="${tlink(t)}">${esc(t.title)}</a></td><td>${esc(t.state)}</td><td class="nowrap small">${fmtTime(t.hidden_at)}</td><td class="num"><button data-restore="${esc(t.id)}">${ic('refresh')}Restore</button></td></tr>`).join(''))
      : `<div class="card">${empty('No deleted tickets. Delete a ticket from its page to hide it here.', 'trash')}</div>`}`;
  view.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    const res = await fetch(`/api/tickets/${encodeURIComponent(b.dataset.restore)}/override`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hidden: false }) });
    if (!res.ok) { b.textContent = `Failed (HTTP ${res.status})`; return; }
    await load();
    route();
  }));
}

// ---------- syncs ----------
async function syncs(view) {
  crumbs([['Syncs']]);
  const list = await api('/api/syncs');
  const stat = s => { try { const j = JSON.parse(s || '{}'); return `${j.fetched ?? 0} fetched · ${j.new ?? 0} new · ${j.changed ?? 0} changed`; } catch { return ''; } };
  view.innerHTML = `${pageHead('Synchronization', `GitHub organization <code>ilmiya</code>, every repository discovered automatically, issues authored by <b>${esc(data.config.people.me)}</b>. Incremental syncs fetch what changed since the last cursor. A full sweep runs at least weekly and is the only run that may flag a ticket as missing at source (never deleted or closed).`, `<button id="full">${ic('refresh')}Run full re-sync</button>`)}
    ${table('<th>#</th><th>Started</th><th>Duration</th><th>Trigger</th><th>Mode</th><th>Status</th><th>Result</th><th>Errors</th><th>Policy</th>',
      list.map(s => `<tr><td class="mono">${s.id}</td><td class="nowrap small">${fmtTime(s.started_at)}</td><td class="nowrap small">${s.finished_at ? `${Math.round((Date.parse(s.finished_at) - Date.parse(s.started_at)) / 1000)} s` : '—'}</td><td>${esc(s.trigger)}</td><td>${esc(s.mode)}</td><td><span class="pill ${s.status === 'success' ? 'good' : s.status === 'running' ? 'warning' : 'critical'}">${esc(s.status)}</span></td><td class="small">${esc(stat(s.stats))}</td><td class="small">${esc(s.errors === '[]' ? '' : s.errors)}</td><td class="mono">${esc(s.policy_version)}</td></tr>`).join(''))}`;
  $('#full').addEventListener('click', async e => {
    e.currentTarget.disabled = true; e.currentTarget.innerHTML = `${ic('refresh')}Running…`;
    try { await api('/api/sync?full=1', { method: 'POST' }); } catch (err) { $('#banner').innerHTML = alertBox('bad', `Full re-sync failed: ${err.message}`); }
    await load(); route();
  });
}

// ---------- router ----------
async function route() {
  const [path, qs] = (location.hash.slice(1) || '/overview').split('?');
  const params = new URLSearchParams(qs);
  if (data) renderNav();
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
    else if (path === '/deleted') await deleted(view);
    else view.innerHTML = empty('Page not found.', 'search');
  } catch (err) {
    view.innerHTML = alertBox('bad', `Failed to load: ${err.message}`);
  }
}

addEventListener('hashchange', () => { route(); scrollTo(0, 0); });
load().then(route).catch(err => { $('#view').innerHTML = alertBox('bad', `Cannot load ticket data: ${err.message}`); });
