import { factsOf, policyVersion, priorityOf, tracked } from './model.js';

const PAGE = 50, CONCURRENCY = 4, LOCK_MS = 30 * 60e3, CURSOR_OVERLAP_MS = 10 * 60e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// GitHub request with retries for network errors, 5xx and secondary rate limits.
async function request(token, path, init, fetchImpl) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(`https://api.github.com${path}`, { ...init, headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'ilmiya-tickets' } });
    } catch (e) {
      if (attempt < 5) { await sleep(2 ** attempt * 2000); continue; }
      throw new Error(`GitHub request failed: ${e.cause?.code || e.message}`);
    }
    const retryAfter = res.headers.get('retry-after');
    if ((res.status >= 500 || res.status === 429 || (res.status === 403 && retryAfter)) && attempt < 5) {
      await sleep(Math.min(60, Number(retryAfter) || 2 ** attempt * 2) * 1000);
      continue;
    }
    return res;
  }
}

export async function gql(token, query, variables, fetchImpl = fetch) {
  const res = await request(token, '/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) }, fetchImpl);
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`GitHub GraphQL: ${body.errors.map(e => e.type || e.message).join('; ').slice(0, 300)}`);
  const rl = body.data.rateLimit;
  if (rl && rl.remaining < 100) throw Object.assign(new Error(`GitHub rate limit low (${rl.remaining} left, resets ${rl.resetAt})`), { rateLimited: true });
  return body.data;
}

// ---- "Fixed in": which environment branch carries every fix change for an issue ----
// Evidence is read from the environment branches themselves: commits whose message references the issue
// (e.g. "fix(users): … (safina#1339)"), plus commit links from "fixed" comments. A change is identified by its
// commit subject, so a cherry-pick onto main (new SHA, same subject) still counts; a later `Revert "<subject>"`
// on that branch cancels it. Branch presence is what is verified, not a deployment.
const historyQuery = `query($owner:String!,$name:String!,$ref:String!,$since:GitTimestamp,$after:String){ rateLimit{remaining resetAt}
  repository(owner:$owner,name:$name){ ref(qualifiedName:$ref){ target{ ... on Commit{
    history(first:100, after:$after, since:$since){ pageInfo{hasNextPage endCursor} nodes{ oid message committedDate parents(first:2){ totalCount nodes{ oid } } } } } } } } }`;
const commitQuery = `query($owner:String!,$name:String!,$oid:String!){ rateLimit{remaining resetAt}
  repository(owner:$owner,name:$name){ object(expression:$oid){ ... on Commit{ oid message committedDate parents{totalCount} } } } }`;

const stripPr = s => s.replace(/(\s*\(#\d+\))+\s*$/, '').trim();
const subjectOf = msg => stripPr(msg.split('\n')[0]).toLowerCase();
export function changeId(c) {
  const subject = subjectOf(c.message);
  const revert = subject.match(/^revert "(.+)"$/);
  const target = revert ? stripPr(revert[1]) : subject;
  const pr = target.match(/^merge pull request #(\d+)/);
  return { kind: revert ? 'revert' : c.parents.totalCount > 1 ? 'merge' : 'apply', id: pr ? `pr#${pr[1]}` : target };
}

// When each commit landed on a branch: the committer date of the mainline (first-parent) commit that brought
// it in. A fix written on 10-14 and promoted to main by a 10-21 merge landed on main on 10-21, not 10-14.
// (A fast-forward promotion has no merge commit, so its commits keep their own dates.)
export function landedAt(commits) {
  const byOid = new Map(commits.map(c => [c.oid, c]));
  const mainline = [];
  for (let c = commits[0]; c && !mainline.includes(c); c = byOid.get(c.parents.nodes[0]?.oid)) mainline.push(c);
  const landed = new Map();
  for (const m of mainline.reverse()) {
    const stack = [m];
    while (stack.length) {
      const c = stack.pop();
      if (!c || landed.has(c.oid)) continue;
      landed.set(c.oid, m.committedDate);
      for (const p of c.parents.nodes.slice(c === m ? 1 : 0)) stack.push(byOid.get(p.oid));
    }
  }
  return landed;
}

async function branchHistory(q, repo, branch, since) {
  const [owner, name] = repo.split('/');
  const out = [];
  for (let after = null; ;) {
    const ref = (await q(historyQuery, { owner, name, ref: `refs/heads/${branch}`, since, after })).repository.ref;
    if (!ref) return null;
    const h = ref.target.history;
    out.push(...h.nodes);
    if (!h.pageInfo.hasNextPage) return out;
    after = h.pageInfo.endCursor;
  }
}

async function updateFixEnvs(db, cfg, q, ctx) {
  const fe = cfg.fixEnvironments;
  const tickets = (await db.prepare("SELECT id, repo, number, created_at, facts, fix_env FROM tickets WHERE state_reason IS NOT 'NOT_PLANNED'").all()).results;
  if (!tickets.length) return;
  const byKey = new Map(tickets.map(t => [`${t.repo.split('/')[1]}#${t.number}`.toLowerCase(), t]));
  const names = [...new Set(tickets.map(t => t.repo.split('/')[1]))].map(n => n.replace(/[.-]/g, '\\$&')).join('|');
  const REF = new RegExp(`(?:ilmiya/)?\\b(${names})(?:#|/issues/)(\\d+)\\b`, 'gi');
  const since = new Date(Math.min(...tickets.map(t => Date.parse(t.created_at))) - 2 * 864e5).toISOString();

  const presence = {}; // repo -> branch -> Map(id -> { apply, revert })   (null branch map = branch missing)
  const shas = new Map(); // `${repo}@${oid}` -> commit
  const wanted = new Map(); // ticket id -> Map(`${repo}|${changeId}` -> evidence)
  const want = (t, repo, c, via) => {
    const { kind, id } = changeId(c);
    if (kind === 'revert') return;
    if (!wanted.has(t.id)) wanted.set(t.id, new Map());
    const m = wanted.get(t.id), key = `${repo}|${id}`;
    if (!m.has(key)) m.set(key, { repo, id, kind, sha: c.oid.slice(0, 8), subject: c.message.split('\n')[0].slice(0, 140), via, committed_at: c.committedDate });
  };
  const pairs = fe.repos.flatMap(repo => fe.branches.map(([branch]) => [repo, branch]));
  const histories = await Promise.all(pairs.map(([repo, branch]) => branchHistory(q, repo, branch, since)));
  for (const [i, [repo, branch]] of pairs.entries()) {
    presence[repo] ??= {};
    if (!histories[i]) { presence[repo][branch] = null; continue; }
    const idx = (presence[repo][branch] = new Map());
    const landed = landedAt(histories[i]);
    for (const c of histories[i]) {
      shas.set(`${repo}@${c.oid}`, c);
      const { kind, id } = changeId(c);
      const e = idx.get(id) ?? {};
      const k = kind === 'revert' ? 'revert' : 'apply';
      if (!e[k] || c.committedDate > e[k]) {
        e[k] = c.committedDate;
        if (k === 'apply') e.landed = landed.get(c.oid) ?? c.committedDate;
      }
      idx.set(id, e);
      for (const m of c.message.matchAll(REF)) {
        const t = byKey.get(`${m[1]}#${m[2]}`.toLowerCase());
        if (t) want(t, repo, c, `commit message on ${branch}`);
      }
    }
  }
  for (const t of tickets) {
    const refs = (JSON.parse(t.facts || '{}').fix_refs ?? []).filter(r => r.type === 'commit' && fe.repos.includes(r.repo));
    for (const r of refs) {
      let c = [...shas.entries()].find(([k]) => k.startsWith(`${r.repo}@${r.sha}`))?.[1];
      if (!c) {
        const [owner, name] = r.repo.split('/');
        c = (await q(commitQuery, { owner, name, oid: r.sha })).repository.object;
      }
      if (c) want(t, r.repo, c, r.via);
    }
  }

  const has = (repo, branch, id) => { const e = presence[repo]?.[branch]?.get(id); return !!e?.apply && !(e.revert > e.apply); };
  for (const t of tickets) {
    const all = [...(wanted.get(t.id)?.values() ?? [])];
    // Merge commits only stand for the change when no plain commit references the issue.
    const required = all.some(e => e.kind === 'apply') ? all.filter(e => e.kind === 'apply') : all;
    const evidence = required.map(e => ({
      ...e,
      branches: Object.fromEntries(fe.branches.map(([b]) => [b, has(e.repo, b, e.id)])),
      landed: Object.fromEntries(fe.branches.map(([b]) => [b, has(e.repo, b, e.id) ? presence[e.repo][b].get(e.id).landed : null])),
    }));
    const env = evidence.length ? fe.branches.find(([b]) => evidence.every(e => e.branches[b]))?.[1] ?? null : null;
    // An environment is reached when its last fix change landed there.
    const reached = Object.fromEntries(fe.branches.filter(([b]) => evidence.length && evidence.every(e => e.branches[b])).map(([b, name]) => [name, evidence.map(e => e.landed[b]).sort().at(-1)]));
    const prev = JSON.parse(t.fix_env || 'null');
    if (!ctx.baseline && (prev?.env ?? null) !== env) {
      await db.prepare('INSERT INTO changes (ticket_id, sync_id, at, field, old, new) VALUES (?,?,?,?,?,?)').bind(t.id, ctx.syncId, ctx.now, 'fixed_in', prev?.env ?? null, env).run();
      ctx.stats.changed++;
    }
    await db.prepare('UPDATE tickets SET fix_env = ? WHERE id = ?').bind(JSON.stringify({ env, reached, evidence, checked_at: ctx.now }), t.id).run();
  }
}

const ACTOR = 'actor{login}';
const REF = '__typename ... on Issue{number url state repository{nameWithOwner}} ... on PullRequest{number url state repository{nameWithOwner}}';
const timeline = pr => `timelineItems(first:100, itemTypes:[ISSUE_COMMENT,ASSIGNED_EVENT,UNASSIGNED_EVENT,LABELED_EVENT,UNLABELED_EVENT,CLOSED_EVENT,REOPENED_EVENT,CROSS_REFERENCED_EVENT,CONNECTED_EVENT,MILESTONED_EVENT,DEMILESTONED_EVENT${pr ? ',PULL_REQUEST_REVIEW,MERGED_EVENT,READY_FOR_REVIEW_EVENT' : ''}]){
  totalCount nodes{ __typename
    ... on IssueComment{createdAt author{login} body url}
    ... on AssignedEvent{createdAt ${ACTOR} assignee{... on User{login}}}
    ... on UnassignedEvent{createdAt ${ACTOR} assignee{... on User{login}}}
    ... on LabeledEvent{createdAt ${ACTOR} label{name}}
    ... on UnlabeledEvent{createdAt ${ACTOR} label{name}}
    ... on ClosedEvent{createdAt ${ACTOR} stateReason}
    ... on ReopenedEvent{createdAt ${ACTOR}}
    ... on CrossReferencedEvent{createdAt ${ACTOR} source{${REF}}}
    ... on ConnectedEvent{createdAt ${ACTOR} subject{${REF}}}
    ... on MilestonedEvent{createdAt ${ACTOR} milestoneTitle}
    ... on DemilestonedEvent{createdAt ${ACTOR} milestoneTitle}
    ${pr ? `... on PullRequestReview{createdAt author{login} state} ... on MergedEvent{createdAt ${ACTOR}} ... on ReadyForReviewEvent{createdAt ${ACTOR}}` : ''}
  } }`;
const PROJECT = 'projectItems(first:5){nodes{fieldValues(first:20){nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}}}}}}';
const fields = (cfg, pr) => `id number title body url state createdAt updatedAt closedAt author{login}
  milestone{title dueOn} assignees(first:10){nodes{login}} labels(first:30){nodes{name}} comments{totalCount}
  ${pr ? 'isDraft mergedAt' : 'stateReason issueType{name} blockedBy(first:10){nodes{number state repository{nameWithOwner}}}'}
  ${cfg.readProjectFields ? PROJECT : ''} ${timeline(pr)}`;

const issuesQuery = cfg => `query($owner:String!,$name:String!,$after:String,$since:DateTime,$author:String){ rateLimit{remaining resetAt}
  repository(owner:$owner,name:$name){ issues(first:${PAGE}, after:$after, orderBy:{field:UPDATED_AT,direction:ASC}, filterBy:{since:$since, createdBy:$author}){
    pageInfo{hasNextPage endCursor} nodes{ ${fields(cfg, false)} } } } }`;
const prsQuery = cfg => `query($owner:String!,$name:String!,$after:String){ rateLimit{remaining resetAt}
  repository(owner:$owner,name:$name){ pullRequests(first:${PAGE}, after:$after, orderBy:{field:UPDATED_AT,direction:DESC}){
    pageInfo{hasNextPage endCursor} nodes{ ${fields(cfg, true)} } } } }`;
const reposQuery = `query($org:String!,$after:String){ rateLimit{remaining resetAt}
  organization(login:$org){ repositories(first:100, after:$after){ pageInfo{hasNextPage endCursor} nodes{ name isArchived hasIssuesEnabled } } } }`;

function event(e) {
  const at = e.createdAt, actor = e.actor?.login ?? e.author?.login ?? null;
  const ref = (t, s) => s?.repository && { t, at, actor, kind: s.__typename, ref: `${s.repository.nameWithOwner}#${s.number}`, url: s.url, state: s.state };
  switch (e.__typename) {
    case 'IssueComment': return { t: 'comment', at, actor, text: e.body?.slice(0, 1000), url: e.url };
    case 'AssignedEvent': return { t: 'assigned', at, actor, who: e.assignee?.login };
    case 'UnassignedEvent': return { t: 'unassigned', at, actor, who: e.assignee?.login };
    case 'LabeledEvent': return { t: 'labeled', at, actor, label: e.label?.name };
    case 'UnlabeledEvent': return { t: 'unlabeled', at, actor, label: e.label?.name };
    case 'ClosedEvent': return { t: 'closed', at, actor, reason: e.stateReason };
    case 'ReopenedEvent': return { t: 'reopened', at, actor };
    case 'CrossReferencedEvent': return ref('xref', e.source);
    case 'ConnectedEvent': return ref('connected', e.subject);
    case 'MilestonedEvent': return { t: 'milestoned', at, actor, milestone: e.milestoneTitle };
    case 'DemilestonedEvent': return { t: 'demilestoned', at, actor, milestone: e.milestoneTitle };
    case 'PullRequestReview': return { t: 'review', at, actor, review: e.state };
    case 'MergedEvent': return { t: 'merged', at, actor };
    case 'ReadyForReviewEvent': return { t: 'ready_for_review', at, actor };
  }
}

// Commit links in comments that claim a fix only point at a commit; whether that commit is on a branch is
// decided from the branch history (updateFixEnvs), never from the comment's wording. The description is
// skipped on purpose: issue reports cite the buggy code, not the fix.
const LINK = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/commit\/([0-9a-f]{7,40})/g;
const FIX_WORDS = /\b(fix(ed|es)?|resolved|merged|deployed|shipped)\b/i;
function fixRefs(n) {
  const refs = new Map();
  for (const e of n.timelineItems.nodes) {
    if (e.__typename !== 'IssueComment' || !FIX_WORDS.test(e.body ?? '')) continue;
    const via = `comment by ${e.author?.login ?? 'unknown'} ${e.createdAt.slice(0, 10)}`;
    for (const m of e.body.matchAll(LINK)) refs.set(`${m[1]}@${m[2]}`, { type: 'commit', repo: m[1], sha: m[2], via });
  }
  return [...refs.values()];
}

export function normalize(cfg, n, repo, kind) {
  const labels = n.labels.nodes.map(l => l.name).sort();
  const projectFields = Object.fromEntries((n.projectItems?.nodes ?? []).flatMap(i => i.fieldValues.nodes).filter(v => v?.field).map(v => [v.field.name, v.name]));
  const [priority, priority_source] = priorityOf(cfg, n.title, labels, projectFields);
  const tl = n.timelineItems.nodes.map(event).filter(Boolean);
  const t = {
    id: `github:${n.id}`, source: 'github', repo, number: n.number, kind, title: n.title, body: n.body, url: n.url,
    state: n.state === 'MERGED' ? 'CLOSED' : n.state, state_reason: n.stateReason ?? null, author: n.author?.login ?? 'ghost',
    assignees: n.assignees.nodes.map(a => a.login).sort(), labels, milestone: n.milestone?.title ?? null, milestone_due: n.milestone?.dueOn ?? null,
    issue_type: n.issueType?.name ?? null, priority, priority_source, project_status: projectFields.Status ?? null,
    created_at: n.createdAt, updated_at: n.updatedAt, closed_at: n.closedAt, merged_at: n.mergedAt ?? null, is_draft: n.isDraft ? 1 : 0,
    comments_count: n.comments.totalCount, timeline_truncated: n.timelineItems.totalCount > tl.length ? 1 : 0,
    blocked_by: (n.blockedBy?.nodes ?? []).map(b => ({ ref: `${b.repository.nameWithOwner}#${b.number}`, state: b.state })),
  };
  t.tracked = JSON.stringify(tracked(cfg, t));
  t.facts = JSON.stringify({ ...factsOf(t, tl, t.timeline_truncated), fix_refs: fixRefs(n) });
  t.timeline = JSON.stringify(tl);
  for (const k of ['assignees', 'labels', 'blocked_by']) t[k] = JSON.stringify(t[k]);
  return t;
}

const COLS = ['id', 'source', 'repo', 'number', 'kind', 'title', 'body', 'url', 'state', 'state_reason', 'author', 'assignees', 'labels', 'milestone', 'milestone_due', 'issue_type', 'priority', 'priority_source', 'project_status', 'created_at', 'updated_at', 'closed_at', 'merged_at', 'is_draft', 'comments_count', 'timeline', 'timeline_truncated', 'blocked_by', 'facts', 'tracked', 'first_seen_sync', 'last_seen_sync', 'missing_since', 'synced_at'];
const UPSERT = `INSERT INTO tickets (${COLS}) VALUES (${COLS.map(() => '?')}) ON CONFLICT(id) DO UPDATE SET ${COLS.filter(c => c !== 'id' && c !== 'first_seen_sync').map(c => `${c}=excluded.${c}`)}`;

async function savePage(db, rows, ctx) {
  if (!rows.length) return;
  const existing = new Map((await db.prepare(`SELECT id, tracked FROM tickets WHERE id IN (${rows.map(() => '?')})`).bind(...rows.map(r => r.id)).all()).results.map(r => [r.id, r.tracked]));
  const stmts = [];
  const change = (id, field, o, n) => db.prepare('INSERT INTO changes (ticket_id, sync_id, at, field, old, new) VALUES (?,?,?,?,?,?)')
    .bind(id, ctx.syncId, ctx.now, field, o == null ? null : typeof o === 'string' ? o : JSON.stringify(o), n == null ? null : typeof n === 'string' ? n : JSON.stringify(n));
  for (const r of rows) {
    const old = existing.get(r.id);
    Object.assign(r, { first_seen_sync: ctx.syncId, last_seen_sync: ctx.syncId, missing_since: null, synced_at: ctx.now });
    ctx.stats.fetched++;
    if (old === undefined) {
      ctx.stats.new++;
      if (!ctx.baseline) stmts.push(change(r.id, '_new', null, r.created_at >= ctx.prevSuccessStart ? 'created' : 'discovered'));
    } else if (old !== r.tracked) {
      ctx.stats.changed++;
      const o = JSON.parse(old), n = JSON.parse(r.tracked);
      for (const k of Object.keys(n)) if (JSON.stringify(o[k]) !== JSON.stringify(n[k])) stmts.push(change(r.id, k, o[k], n[k]));
    } else ctx.stats.unchanged++;
    if (old !== r.tracked) stmts.push(db.prepare('INSERT OR REPLACE INTO snapshots (ticket_id, sync_id, captured_at, data) VALUES (?,?,?,?)').bind(r.id, ctx.syncId, ctx.now, r.tracked));
    stmts.push(db.prepare(UPSERT).bind(...COLS.map(c => r[c] ?? null)));
  }
  await db.batch(stmts);
}

async function syncScope(cfg, db, q, owner, name, kind, since, author, ctx) {
  let after = null;
  for (;;) {
    const data = await q(kind === 'issue' ? issuesQuery(cfg) : prsQuery(cfg), { owner, name, after, ...(kind === 'issue' && { since, author }) });
    const conn = kind === 'issue' ? data.repository.issues : data.repository.pullRequests;
    // PRs have no `since`/author filter: they come newest-updated first, so stop at the first one older than the cursor.
    const nodes = since && kind === 'pr' ? conn.nodes.filter(n => n.updatedAt >= since) : conn.nodes;
    const mine = author ? nodes.filter(n => n.author?.login === author) : nodes;
    await savePage(db, mine.map(n => normalize(cfg, n, `${owner}/${name}`, kind)), ctx);
    if (!conn.pageInfo.hasNextPage || nodes.length < conn.nodes.length) return;
    after = conn.pageInfo.endCursor;
  }
}

export async function sync(db, cfg, { token, trigger = 'manual', full = false, fetchImpl = fetch } = {}) {
  const startedAt = new Date().toISOString();
  await db.prepare("UPDATE syncs SET status='failed', errors=? WHERE status='running' AND started_at < ?")
    .bind(JSON.stringify([{ scope: '*', error: 'abandoned (process stopped mid-sync)' }]), new Date(Date.now() - LOCK_MS).toISOString()).run();
  const running = await db.prepare("SELECT id FROM syncs WHERE status='running'").first();
  if (running) return { skipped: `sync #${running.id} is already running` };

  const prev = await db.prepare("SELECT started_at FROM syncs WHERE status IN ('success','partial') ORDER BY id DESC LIMIT 1").first();
  const lastFull = await db.prepare("SELECT started_at FROM syncs WHERE status='success' AND mode='full' ORDER BY id DESC LIMIT 1").first();
  const mode = full || !lastFull || Date.parse(lastFull.started_at) < Date.now() - cfg.fullSyncEveryDays * 864e5 ? 'full' : 'incremental';
  const version = await policyVersion(cfg);
  await db.prepare('INSERT OR IGNORE INTO policy_versions (version, created_at, policies) VALUES (?,?,?)').bind(version, startedAt, JSON.stringify(cfg.sla)).run();
  const { id: syncId } = await db.prepare("INSERT INTO syncs (started_at, status, trigger, mode, policy_version) VALUES (?, 'running', ?, ?, ?) RETURNING id").bind(startedAt, trigger, mode, version).first();

  const ctx = { syncId, now: startedAt, baseline: !prev, prevSuccessStart: prev?.started_at ?? '', stats: { repos: 0, scopes: 0, fetched: 0, new: 0, changed: 0, unchanged: 0, missing: 0 }, errors: [] };
  const q = (query, vars) => gql(token, query, vars, fetchImpl);
  const nextCursor = new Date(Date.parse(startedAt) - CURSOR_OVERLAP_MS).toISOString();
  try {
    if (!token) throw new Error('No GitHub token configured (GITHUB_TOKEN secret / `gh auth login`)');
    const scopes = [];
    for (const src of cfg.sources) {
      const repos = [];
      for (let after = null; ;) {
        const page = (await q(reposQuery, { org: src.org, after })).organization.repositories;
        repos.push(...page.nodes.filter(r => !src.exclude?.includes(r.name)));
        if (!page.pageInfo.hasNextPage) break;
        after = page.pageInfo.endCursor;
      }
      ctx.stats.repos += repos.length;
      for (const repo of repos) for (const kind of src.kinds) {
        if (kind !== 'issue' || repo.hasIssuesEnabled) scopes.push({ org: src.org, repo: repo.name, kind, author: src.author ?? null, scope: `github:${src.org}/${repo.name}:${kind}${src.author ? `:by:${src.author}` : ""}` });
      }
    }
    let next = 0, stop = false;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (!stop && next < scopes.length) {
        const s = scopes[next++];
        const since = mode === 'full' ? null : (await db.prepare('SELECT since FROM cursors WHERE scope = ?').bind(s.scope).first())?.since ?? null;
        try {
          await syncScope(cfg, db, q, s.org, s.repo, s.kind, since, s.author, ctx);
          await db.prepare('INSERT INTO cursors (scope, since) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET since = excluded.since').bind(s.scope, nextCursor).run();
          ctx.stats.scopes++;
        } catch (e) {
          ctx.errors.push({ scope: s.scope, error: String(e.message || e) });
          if (e.rateLimited) stop = true;
        }
      }
    }));
    if (stop) ctx.errors.push({ scope: '*', error: 'stopped early: GitHub rate limit' });
    else if (cfg.fixEnvironments) {
      try { await updateFixEnvs(db, cfg, q, ctx); } catch (e) { ctx.errors.push({ scope: 'fixed-in', error: String(e.message || e) }); }
    }
    // Only a complete full sweep can say a ticket was not returned. Even then it is flagged, never deleted or closed.
    if (mode === 'full' && !ctx.errors.length) {
      const r = await db.prepare('UPDATE tickets SET missing_since = ? WHERE last_seen_sync < ? AND missing_since IS NULL').bind(startedAt, syncId).run();
      ctx.stats.missing = r.meta?.changes ?? 0;
    }
  } catch (e) {
    ctx.errors.push({ scope: '*', error: String(e.message || e) });
  }
  const status = !ctx.errors.length ? 'success' : ctx.stats.scopes ? 'partial' : 'failed';
  await db.prepare('UPDATE syncs SET finished_at = ?, status = ?, stats = ?, errors = ? WHERE id = ?')
    .bind(new Date().toISOString(), status, JSON.stringify(ctx.stats), JSON.stringify(ctx.errors), syncId).run();
  return { id: syncId, status, mode, stats: ctx.stats, errors: ctx.errors };
}
