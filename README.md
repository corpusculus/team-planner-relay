# Team Planner Relay

Team capacity planner for Jira Cloud: work queue, calendar, coverage, PM outlook, estimates and timesheets, as an Atlassian Forge app. Free, MIT licensed.
Started from `team-planner.html`; the scheduler and screens are the same, now backed by Forge storage and Jira issues.

## See it locally

```sh
npm install
npm run dev        # http://localhost:5173/static/planner/  and  /static/settings/
npm test
```

Local mode runs the real backend in the browser (localStorage, no Jira). It starts with the fictional demo team.

## Put it in Jira

The app is registered as **Team Planner Relay** (Developer Space "Apps") and deployed to the Forge **production** environment.
It is eligible for Atlassian's *Runs on Atlassian* program: no data leaves Atlassian.

- **Deploy a new version:** `forge login` once, then `npm run deploy`. Admins accept new permissions with `forge install --upgrade` or from the app page in Jira.
- **Install on a site you administer:** `forge install -e production --product jira --site <site>.atlassian.net`
- **Install on someone else's site:** developer console → [Distribution](https://developer.atlassian.com/console/myapps/d480a29e-d346-449b-b4d8-8019c22c5279/manage/distribution) → enable sharing → copy the installation link → send it to that site's admin with [ADMIN.md](ADMIN.md).

In Jira: Apps → **Team Planner Relay**. Admins: Jira settings → Apps → **Team Planner Relay settings**.

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

## Support and privacy

- Support: https://github.com/corpusculus/team-planner-relay/issues
- Privacy policy: [PRIVACY.md](PRIVACY.md)

## License

MIT, free of charge. See [LICENSE](LICENSE).

## Known limits (v1)

- Read-only on Jira: no assignment or status write-back, no worklog sync.
- One prerequisite per task (first Jira "is blocked by" link).
- Plan and timesheets live in one storage key (~240 KB limit) and writes are not atomic. Fine for one team.
- People, projects, systems and task types are archived, not deleted (the plan refers to them by position).
- Workdays are fixed to Monday–Friday; no holiday calendar.
