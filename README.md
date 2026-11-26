# Relay for Jira

Team planner (queue, calendar, coverage, PM outlook, timesheets) as an Atlassian Forge app.
Started from `team-planner.html`; the scheduler and screens are the same, now backed by Forge storage and Jira issues.

## See it locally

```sh
npm install
npm run dev        # http://localhost:5173/static/planner/  and  /static/settings/
npm test
```

Local mode runs the real backend in the browser (localStorage, no Jira). It starts with the fictional demo team.

## Put it in Jira

1. Create a free dev site: https://developer.atlassian.com/platform/forge/getting-started/
2. `npm i -g @forge/cli && forge login` (Atlassian email + API token)
3. `forge register` (writes the real app id into `manifest.yml`)
4. `npm run deploy && forge install` (choose Jira and your site)
5. Jira → Apps → **Relay**. Admins: Jira settings → Apps → **Relay settings** to switch to live data, add people and connect projects.

## How it fits together

| Path | Role |
|---|---|
| `manifest.yml` | Jira global page (planner) + admin page (settings), read-only Jira scopes, app storage |
| `src/index.js` | Forge resolver: KVS storage, Jira REST as the signed-in user |
| `src/service.js` | Backend logic: roles, redaction, revision checks, Jira refresh, settings |
| `src/shared/` | Scheduler (`model.js`), estimator, Jira mapping, settings validation, demo data; used by UI and backend |
| `static/planner`, `static/settings` | Vanilla JS UI, built with Vite into `dist/` |

Estimation: Jira estimate or story points if the task type says so; otherwise P70 of the actual hours of ≥3 similar finished tasks
(same project+system → same system → same type), buffer up to P90; otherwise type default × system size × complexity factors.
Hours round up to slots (default 4h, so at most 2 tasks per person per day).

## License

MIT, free of charge. See [LICENSE](LICENSE).

## Known limits (v1)

- Read-only on Jira: no assignment or status write-back, no worklog sync.
- One prerequisite per task (first Jira "is blocked by" link).
- Plan and timesheets live in one storage key (~240 KB limit) and writes are not atomic. Fine for one team.
- People, projects, systems and task types are archived, not deleted (the plan refers to them by position).
- Workdays are fixed to Monday–Friday; no holiday calendar.
