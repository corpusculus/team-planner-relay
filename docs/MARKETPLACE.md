# Listing Team Planner Relay on the Atlassian Marketplace (free)

## Steps

1. Create a Marketplace partner (vendor) profile with the same Atlassian account that owns the app:
   https://marketplace.atlassian.com/manage/vendors/create
2. In the developer console, open the app → **Distribution** → **List on Marketplace**, and link it to that partner profile.
3. Choose **Free** pricing.
4. Fill in the listing with the copy below, the logo (`assets/icon-512.png`) and screenshots (take them from a test site with demo data).
5. Answer the **data security and privacy** questions. The answers are in [PRIVACY.md](../PRIVACY.md) and [ADMIN.md](../ADMIN.md):
   the app runs on Atlassian only (*Runs on Atlassian*), stores data in Forge storage, has no outside servers, analytics or tracking.
6. Submit for review. Atlassian checks the listing and the app's security before it goes public. Their form gives the
   current image sizes and any extra documents they need.

Links to use in the listing:
- Privacy policy: https://github.com/corpusculus/team-planner-relay/blob/main/PRIVACY.md
- Support: https://github.com/corpusculus/team-planner-relay/issues
- Source code (MIT): https://github.com/corpusculus/team-planner-relay

## Listing copy

**Name:** Team Planner Relay

**Short description** (developer console → Distribution, shown on the install page):
Team capacity planning for Jira: schedule issues on a shared team calendar, forecast project dates, manage time off and log time as Jira work logs.

**Longer description** (if the field allows a few sentences):
Team Planner Relay plans your Jira issues on one team calendar. It estimates work from your own history, respects holidays,
part-time days and time off, and gives each project a realistic forecast date. Members log time as Jira work logs and can request
time off for their manager to approve. Runs entirely on Atlassian. No outside servers.

**Tagline:** Team capacity planning on top of your Jira issues — estimates, calendar and timesheets in one place.

**Summary:** Plan who does what, and when, across several Jira projects and teams. Relay schedules your issues on a shared team calendar,
estimates them from your own history, respects holidays and part-time days, and shows each project manager a realistic
forecast. Time is logged straight into Jira work logs.

**Highlights**

1. **One calendar for every project.** Connect any number of Jira projects. Relay plans them together for the same team, so nobody
   is double-booked, and gives each project its own forecast date.
2. **Estimates that learn.** Task types with base hours and buffers, scaled by system size and complexity, and replaced by the
   70th percentile of your finished work once there is enough history.
3. **Realistic capacity.** Public holidays, part-time days, weekly focus time and time off (half days too) are all part of the plan.
   Members can request time off for their manager to approve. Preview any change, drag tasks on the calendar, undo the last one.
4. **Time logged in Jira.** Log time from Relay as Jira work logs, and optionally time off on its own internal issues, apart from
   customer work. Reports, an estimate accuracy report and CSV export read them back.
5. **Right where people work.** A Team plan panel on every Jira issue shows who it is planned for and when. Optional status moves
   and comments keep Jira in step with the plan.
6. **Safe by role, for several teams.** Each team has its own plan. Team members, team managers and project managers each see what
   they need; project managers only see issues Jira lets them browse.

**Category suggestions:** Project management, Time tracking, Workflow.
