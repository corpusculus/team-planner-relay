# Team Planner Relay — Privacy Policy

Last updated: 26 November 2026

Team Planner Relay ("the app") is a free, open-source (MIT) planning app for Jira Cloud, built and run on Atlassian Forge.
It is made by Vedran Vukosav as a private individual ("the developer").

## Summary

- The app runs entirely on Atlassian's platform (Atlassian Forge, "Runs on Atlassian"). It has no servers of its own.
- Data the app stores stays in Atlassian-hosted Forge storage, inside your site's installation of the app.
- The app sends no data to the developer or to any third party. It has no analytics, tracking, cookies or ads.
- The developer cannot read your planning data.

## What the app reads

When a team manager presses *Refresh*, the app reads Jira issues from the projects an administrator connected, using that person's
Jira access. It reads issue key, summary, type, components, labels, assignee, original estimate, story points, issue links,
time spent and resolution date. When an administrator adds team members, the app searches Jira users by name.

## What the app stores

In Forge storage, inside your installation:
- **Team settings:** people's display names, Jira account IDs, job titles, roles in the app and skills; projects, task types and estimation rules.
- **Planning data:** tasks (including Jira issue keys and summaries), estimates, assignments, blockers, agreed dates, private-time labels, absences and shared project notes.
- **Timesheets:** date, duration, task and an optional personal note for each time entry.
- **Estimation history:** hours spent on finished tasks, with no personal details.

The app never writes to Jira.

## Who can see it

Access is decided by your site's administrators in the app's settings and enforced by the app:
- Team members see their own assignments and timesheets.
- Team managers see the team plan and timesheet totals, but not other people's personal timesheet notes.
- Project managers see their projects' outlook, and only the issue titles Jira lets them browse.
- Private-time labels and personal notes are visible only to their owner.

## Logs

If the app hits an unexpected error, it writes a technical error message to Atlassian's app logs. These logs are meant for fixing bugs
and the app does not deliberately put planning data in them. Atlassian's rules decide when the developer may view logs from your site.

## Keeping and deleting data

Data stays until an administrator removes it in the app or uninstalls the app. After uninstalling, Atlassian deletes the app's stored
data according to Atlassian's Forge data retention policy. People can delete their own timesheet entries at any time; an administrator
can archive a person in the app's settings so they no longer appear in the plan.

## Atlassian

Hosting, storage and security of the platform are provided by Atlassian under Atlassian's own terms and privacy policy:
https://www.atlassian.com/legal/privacy-policy

## Contact

Questions or requests: open an issue at https://github.com/corpusculus/team-planner-relay/issues
