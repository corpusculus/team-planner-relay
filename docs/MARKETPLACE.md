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

**Tagline:** Team capacity planning on top of your Jira issues — estimates, calendar and timesheets in one place.

**Summary:** Plan who does what, and when, across several Jira projects. Relay schedules your issues on a shared team calendar,
estimates them from your own history, respects holidays and part-time days, and shows each project manager a realistic
forecast. Time is logged straight into Jira work logs.

**Highlights**

1. **One calendar for every project.** Connect any number of Jira projects. Relay plans them together for the same team, so nobody
   is double-booked, and gives each project its own forecast date.
2. **Estimates that learn.** Task types with base hours and buffers, scaled by system size and complexity, and replaced by the
   70th percentile of your finished work once there is enough history.
3. **Realistic capacity.** Public holidays, part-time days, private focus time and absences are all part of the plan. Preview any
   change before applying it.
4. **Time logged in Jira.** Log time from Relay as Jira work logs; reports and CSV export read them back.
5. **Safe by role.** Team members, team managers and project managers each see what they need. Project managers only see issues
   Jira lets them browse.

**Category suggestions:** Project management, Time tracking, Workflow.
