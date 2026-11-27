# Team Planner Relay

Team capacity planner for Jira Cloud: work queue, calendar, coverage, monthly capacity, PM outlook, estimates and timesheets, as an Atlassian Forge app. Free, MIT licensed.
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

In Jira: Apps → **Team Planner Relay**. Admins: Jira settings → Apps → **Team Planner Relay settings**. Team managers of a live team: **Settings** in the planner header (their own team; switching demo/live and adding teams stay with Jira admins).

## How it fits together

| Path | Role |
|---|---|
| `manifest.yml` | Jira global page (planner), admin page (settings), issue panel (Team plan), Jira scopes, app storage |
| `src/index.js` | Forge resolver: KVS storage, Jira REST as the signed-in user |
| `src/service.js` | Backend logic: roles, redaction, revision checks, Jira refresh, settings |
| `src/shared/` | Scheduler (`model.js`), estimator, Jira mapping, settings validation, demo data; used by UI and backend |
| `static/planner`, `static/settings`, `static/issue` | Vanilla JS UI, built with Vite into `dist/` |

Estimation: Jira estimate or story points if the task type says so; otherwise P70 of the actual hours of ≥3 similar finished tasks
(same project+system → same system → same type), buffer up to P90; otherwise type default × system size × complexity factors.
Hours round up to slots (default 4h, so at most 2 tasks per person per day).

Capacity (`src/shared/capacity.js`, team manager): per person and month from today, gross hours − time off and holidays = net,
against planned work with buffers, private time, other Jira work (open issues of the settings' *Other Jira projects* assigned
to the team: remaining estimate, else original, spread over weekdays to the due date; no due date = provisional, spread over the horizon)
and monthly loads (per project: fixed, or the average of the hours logged in the last 3 complete months, else the default).
Loads go to the lead, then the backup, each up to the target utilization (85%); the rest is the uncovered gap. Health: under 50% underused,
up to the target healthy, up to 100% stretched, above over. Loads do not move ticket dates. It follows the open what-if.

## Support and privacy

- Support: https://github.com/corpusculus/team-planner-relay/issues
- Privacy policy: [PRIVACY.md](PRIVACY.md)

## License

MIT, free of charge. See [LICENSE](LICENSE).

## Known limits (v1)

- Time is logged only in Jira (work logs). Search results carry up to 20 work logs per issue; an issue with more costs one more request.
- Monthly loads are measured once a month (and on request) from up to 2,000 issues with time logged; other Jira work reads up to 1,000 open issues at each refresh.
- Writes to Jira: work logs (optionally also time off taken, on chosen issues), and on request assignee and due date. Optional (settings): status on start and finish, and comments when an issue's owner or finish changes (at most 20 per change).
- Automatic refresh every 5 minutes when Jira changed (and at least hourly) uses the app's own Jira access; manual refresh uses the team manager's.
- Monday–Friday workweek, with public holidays and per-person working days and hours.
- People, projects, systems and task types are archived, not deleted (the plan refers to them by position).
- The plan lives in one storage key per team (~240 KB); saves from the same revision are guarded so only one wins. Undo goes back one change.
- Teams are added and renamed, not deleted. The first team keeps the original storage keys.
