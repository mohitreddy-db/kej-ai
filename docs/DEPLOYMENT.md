# kejAI Deployment Notes

Living document — update whenever infrastructure or the deploy flow changes.
Last updated: 2026-08-06.

## Production at a glance

| What | Where |
|---|---|
| Public app | http://134.209.151.114 |
| Droplet | DigitalOcean, `ssh root@134.209.151.114` (key: `~/.ssh/id_ed25519`) |
| App directory | `/opt/kejai` (runs as user `kejai`) |
| Service | `systemctl {status,restart} kejai` (`/etc/systemd/system/kejai.service`) |
| Production secrets | `/etc/kejai.env` (DATABASE_URL, OPENAI_API_KEY, OPENAI_MODEL) |
| Database | Supabase project **kej-ai-Prakhar** (`wsthhmcgvrcteewxfidt`), Mumbai (ap-south-1), Session Pooler port 5432, SSL |
| Supabase CA cert | droplet `/etc/kejai/supabase-ca.crt`, local copy `/tmp/prod-supabase.cer` |
| Reverse proxy | Nginx, `/etc/nginx/sites-available/default` → 127.0.0.1:3000 |

## Local secret files (never commit)

- `/tmp/kejai-supabase.env` — Supabase DATABASE_URL (session pooler, with password)
- `.env` in the repo root — OPENAI_API_KEY, OPENAI_MODEL (gitignored)

## Git: two diverged histories — read before pushing

There are two remotes with **separate commit histories** whose file contents have
converged:

- `origin` = github.com/mohitreddy-db/kej-ai — **this is what the droplet pulls.**
  Pushing requires the `~/.ssh/id_ed25519_db` key
  (`GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519_db -o IdentitiesOnly=yes" git push origin ...`).
  The default SSH key authenticates as a different GitHub account (M0hitReddy).
- `sites` = git.chatgpt-team.site — tracks the *local* line and backs
  kejai.goroutine.in (CNAME to custom-domains.chatgpt.site).

Do **not** merge the two lines casually. The proven backend deploy method:
make a detached worktree from `origin/main`, copy only the changed files in,
commit there, push `HEAD:main`.

**Never overwrite `app/Dashboard.js` or `app/globals.css` from the local line** —
production carries a UI restyle (commit `babfbbe`) plus uncommitted hotfixes on
the droplet that the local line does not have.

## Deploy a backend change

```bash
# 1. Locally: commit on top of origin/main (worktree method above), then push
GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519_db -o IdentitiesOnly=yes" git push origin HEAD:main

# 2. On the droplet
ssh root@134.209.151.114
cd /opt/kejai && git pull --ff-only
sudo -u kejai sh -c 'set -a; . /etc/kejai.env; npm run db:rules && npm run build'
systemctl restart kejai

# 3. Verify
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/   # expect 200
```

If the schema changed, add `npm run db:migrate` before the build. If input
workbooks changed, copy them to `/opt/kejai/inputs` and add `npm run db:load`.

## Business rules (single source of truth)

- Edit `db/business-rules.mjs` → run `npm run db:rules` (locally against the
  docker DB; on the droplet against Supabase via `/etc/kejai.env`).
- Rules live in `governance.calculation_rule` (versioned, draft/approved);
  approved rules are injected into the Ask kejAI agent every request and cited
  by code (e.g. `LANDED_COST v2`). Drafts are stored but not shown to the agent.
- Supabase can also be inspected/updated directly through the Supabase MCP
  (`execute_sql` on project `wsthhmcgvrcteewxfidt`).

## Local development

```bash
npm run db:up        # docker Postgres 16 on port 54329
npm run db:setup     # migrate + load inputs/ + load rules + checks
npm run build && npm start   # http://localhost:3000
```

- `npm run dev` currently 404s every route (vinext/Cloudflare dev-mode issue) —
  always use `build` + `start`.
- Local DB shell: `docker exec -it kejai-postgres psql -U kejai -d kejai`
- Full test suite: `npm run check`

## Known state (2026-08-06)

- Supabase and local DB both hold 20 approved + 5 draft rules and the
  `DISPATCH_BEFORE_PO_DATE` flag (Agsar PO 32 has a backdated PO date).
- Data gaps tracked as GAP_* rules: supplier payment ledger, dispatch→lot
  linkage, dispatch-stage quality, auction buyer awards (Bid Details pending
  client confirmation), transporter delivery dates, "best supplier" definition.
- Open client questions live in `kejAI/tmp/qna.txt` (reduced list) and
  `docs/KEJ AI – Business Calculation Validation Questionnaire.docx` (answers).
