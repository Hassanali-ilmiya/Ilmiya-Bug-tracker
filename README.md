# Ilmiya ticket tracker

A private dashboard that tracks ticket status, SLA, progress and engineering health. GitHub is the source of truth. The app only reads from GitHub and never creates or edits tickets.

**Scope (`config.json → sources`):** every repository in the `ilmiya` org, found automatically on each sync. Only issues created by `Hassanali-ilmiya` are tracked. Tickets closed as *not planned* (cancelled) are kept for history but never shown, counted or summarised. To widen the scope, remove `author` (all authors) or add `"pr"` to `kinds`. New repositories are picked up on the next sync with no config change.

## How it works

```
GitHub GraphQL/REST ──► sync (src/sync.js) ──► SQLite (D1 on Cloudflare, node:sqlite locally)
                                               │  tickets · snapshots · changes · syncs · cursors · policy_versions
                                               ▼
                      API + auth (src/worker.js) ──► dashboard (public/)
Triggers: Claude Code hook (first prompt each day) · Cloudflare cron (02:00 UTC) · "Sync now" button
```

- **Identity:** each ticket is keyed by `github:<node id>`, the immutable GitHub ID. Re-syncs upsert by that key, so duplicates can't happen.
- **Incremental sync:** each repo/kind has a cursor, and a sync fetches only what changed since then (with a 10-minute overlap). A cursor moves forward only after its repo finishes without errors. Pagination, retries, back-off and a rate-limit floor are built in.
- **Full sweep:** runs on the first sync and then at least every 7 days. It is the only run allowed to flag tickets as *missing at source*. Missing tickets are never deleted or closed. A partial or failed run never flags anything.
- **History:** when a tracked field changes, the sync writes a snapshot plus one `changes` row per field. Tracked fields are state, assignees, labels, priority, milestone and SLA deadlines. "Completed today" uses GitHub's close timestamp, so a ticket counts as completed once, not every day.
- **Fixed in:** decided from the code, never from what a comment says. On every sync, the app reads the commit history of each environment branch (`main` = production, `staging`, `development` = dev) in `config.json → fixEnvironments.repos`. A fix change is a commit whose message references the issue (e.g. `(safina#1357)`), or a commit linked from a comment that says fixed/merged/deployed; description links are ignored. A change counts as present on a branch if a commit with the same subject is there, so cherry-picks with new SHAs count, and a later `Revert "…"` on that branch cancels it. The column shows the highest environment that contains **every** fix change for the issue. That proves the code is on the branch, not that a deploy finished. A fix nobody referenced (no issue number in the commit, no comment link) shows as *no fix evidence*, never as a wrong environment.
- **Derived values:** status, severity, SLA and "fixed in" are computed from source fields and labelled **derived**; source values are labelled **source**. Values from a truncated timeline (more than 100 events) are labelled **approx**.

## Run locally

Requirements: Node 24+ and `gh auth login`. The token is read at runtime with `gh auth token`. It is never written to disk.

```bash
cd tickets
npm run sync        # one sync now (npm run sync:full forces a full sweep)
npm start           # dashboard at http://127.0.0.1:8787 (bound to localhost only)
npm test            # isolated tests: mocked GitHub, in-memory DB
```

Data lives in `.data/tickets.db`, which is gitignored and in a directory with mode 700. Set `AXIOM_TOKEN` (and `AXIOM_ORG_ID` for a personal token) before `npm start` to enable the Health page.

## Daily sync in Claude Code

A `UserPromptSubmit` hook is installed in `~/.claude/settings.json`, so it applies to every project:

```
node /home/hassan-ali/project/Ilmiya/tickets/local.mjs hook
```

On each prompt it checks the database:

- **Already synced successfully today:** exits silently (about 0.1 s).
- **Not synced today:** syncs every configured source, then adds a summary (counts, changes since the last sync, critical/high, blocked, needs attention, fix environments) to Claude's context with an instruction to summarise it first. Ticket titles are marked as untrusted data.
- **Failed earlier today:** retries at most every 30 minutes and warns, giving the last successful sync time.

Verified on 2026-10-27: a new headless session with an unrelated prompt triggered the sync, and Claude summarised the tickets before answering.

Limitations:

- It fires on the first *prompt* of the day, not at session start.
- The first prompt of the day waits for the sync, about 50 s (measured 2026-10-27), mostly the "Fixed in" branch-history scan.
- The hook uses the absolute nvm Node path (`v24.16.0`); update it in `settings.json` if Node changes.
- Review or disable it with `/hooks`.

**After deploying**, point the hook at the Worker instead of the local DB. Set these where Claude Code starts, e.g. in `settings.json → env`:

- `TICKETS_URL=https://<your domain>`
- `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`, from an Access service token

The hook then calls `POST /api/sync?ifNoSuccessSince=<local midnight>`.

## Deploy to your Cloudflare account (not done yet)

Use a Workers **Paid** plan: a sync exceeds the free plan's 10 ms CPU limit. D1 is the database, a Cron Trigger runs the daily sync, and Cloudflare Access controls who can sign in.

1. `npx wrangler@4.115.0 login`
2. `npx wrangler@4.115.0 d1 create ilmiya-tickets`, then put the returned id in `wrangler.jsonc → database_id`.
3. `npx wrangler@4.115.0 d1 migrations apply ilmiya-tickets --remote`
4. Create a GitHub **fine-grained PAT**: resource owner `ilmiya`, all repositories, read-only *Issues*, *Pull requests*, *Contents* (for compare) and *Metadata*. An org admin may need to approve it. Then `npx wrangler@4.115.0 secret put GITHUB_TOKEN`.
5. Optional: `wrangler secret put AXIOM_TOKEN`, an Axiom API token with query permission on the `production`/`staging`/`development` datasets.
6. Zero Trust → Access → Applications: create a self-hosted app for your custom domain, with a policy allowing your email (and a Service Auth policy for the hook's service token). Copy the team domain and the application **AUD** into `wrangler.jsonc → vars`.
7. `npx wrangler@4.115.0 deploy`, then add the custom domain as a route under Workers → Settings → Domains.

`workers_dev` and preview URLs are disabled, so the only way in is through Access. The Worker also re-verifies the Access JWT and fails closed if Access isn't configured. To check the config without deploying: `npm run check:deploy`.

## Configuration still needed

- **SLA policies (`sla.policies`):** none are configured, so every ticket shows *Policy not configured*. Shape: `{ "id": "sec-p0", "match": { "type": "Security", "priority": "P0" }, "responseHours": 4, "resolutionHours": 72 }`. The first matching policy wins; match keys are `type`, `priority`, `repo` and `kind`. The clock is calendar time only, since business-hours SLAs aren't supported. Each sync records the policy version it used.
- **SLOs (`slos`):** `{ "service": "iam", "environment": "production", "availabilityTarget": 99.9, "windowDays": 30 }`. Availability is 1 − (5xx or error spans) ÷ server spans, measured in Axiom.
- **Priority and project Status:** these live in the GitHub Project, which the current `gh` token can't read (it lacks `read:project`). Run `gh auth refresh -s read:project`, then set `"readProjectFields": true`. Until then, priority comes only from `P0`–`P3` in the title or labels.
- **Fixed in, other repos:** add repos with an environment branch flow to `fixEnvironments.repos`. `ops` merges straight to `main` and is not mapped.
