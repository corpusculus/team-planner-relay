# Team Planner Relay — note for the Jira administrator

Relay is a team planning app for Jira Cloud, built on Atlassian Forge (Atlassian hosts and runs it; there is no external server).
It was written by a team member as a private, free contribution under the MIT license (see LICENSE). It is not a Marketplace app.

## What it does

- Adds **Apps → Team Planner Relay**: work queue, team calendar, project outlook and timesheets, for one or more planning teams.
- Adds a **Team plan** panel to Jira issues: who the issue is planned for, when, and the project forecast.
- Adds **Jira settings → Apps → Team Planner Relay settings** (admins only): team members, connected Jira projects, task types and estimation rules.
- Until an admin switches it to live mode, it only shows fictional demo data. Nothing is read from Jira in demo mode.

## Access it asks for

| Permission | Why |
|---|---|
| `read:jira-work` | Read issues and work logs of the projects you connect, and check which issues a PM may see |
| `write:jira-work` | Log time as Jira work logs; when a team manager asks, set an issue's assignee or due date |
| `read:jira-user` | Find people when adding team members; check that the caller is a Jira admin for the settings page |
| `storage:app` | Store planning data (assignments, estimates, timesheets) in Forge storage inside this installation |

The app is eligible for Atlassian's *Runs on Atlassian* program: it runs and stores data only on Atlassian's platform, with no outside servers.

**What Relay changes in Jira**, and only when someone acts in Relay:
- *Log time* adds, edits or deletes the person's own Jira work log. Time is logged only in Jira.
- Optional, off until an admin sets it: members record time off they have taken as work logs on issues you choose (for example an internal `ABS` project), so it stays apart from customer work.
- *Set Jira assignee* and *Set Jira due date* (team manager only) update that one issue.
- Optional, off until an admin sets it in Relay settings: starting or finishing a task moves its issue to a chosen status,
  and a plan change that gives an issue a new owner or a later finish adds a comment that mentions the people concerned.
It changes nothing else. Every change is made as the person who acted, so Jira's own permissions apply.

**Reading:** a team manager's *Refresh* reads issues with their own Jira access. Every 5 minutes the app checks, with its own access, whether
anything changed in the connected projects and refreshes the plan if so (and at least once an hour). Project managers only see issue titles Jira lets them browse.

## Who sees what

Roles are set by an admin in Relay settings and enforced in the app backend:
- **Team member:** their own assignments, calendar and timesheet.
- **Team manager:** the whole team plan, refresh from Jira, change the plan.
- **Project manager:** forecast, agreed dates and shared notes for their projects; issue titles only where Jira lets them browse the issue.
Private time labels and personal timesheet notes are never sent to other people.

## Installing

Pick one:

**A. Install from the author's link.** The author deploys Relay under their Atlassian developer account and sends an installation link.
Open the link, choose the site, review the permissions above, and confirm.

**B. Deploy it under the company's own account.** This is useful if apps must be owned by the company. Needs Node.js 22 and a terminal.
```sh
npm install
npm install -g @forge/cli
forge login                      # an Atlassian account with an API token
forge register                   # creates the app under that account
npm run build && forge deploy -e production
forge install -e production --product jira --site <your-site>.atlassian.net
```

A sandbox or test site is a good first stop.

## First-time setup (5 minutes)

1. Jira settings → Apps → **Team Planner Relay settings** → *Switch to live Jira data*.
2. **People:** add the team (search by name), set each person's role and skills.
3. **Projects:** connect one pilot project; choose its lead, backup and project managers (people whose role is Project manager).
4. **Task types:** check the rules that match Jira issue types or components to task types.
5. Save, then press *Refresh from Jira now*. Issues that can't be matched are listed under *Needs mapping*.

## Support and privacy

Questions and bug reports: https://github.com/corpusculus/team-planner-relay/issues. Privacy policy: https://github.com/corpusculus/team-planner-relay/blob/main/PRIVACY.md

## Removing it

Jira settings → Apps → Manage apps → Team Planner Relay → Uninstall. Nothing in Jira itself was changed by Relay.

## Known limits (first version)

Monday–Friday workweek (with public holidays and part-time days); history import uses the 1,000 most recently resolved
issues; refresh handles up to 5,000 open issues; built for one team (up to about 30 people).
