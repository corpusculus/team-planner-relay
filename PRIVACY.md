# Team Planner Relay — Privacy Policy

Last updated: 27 November 2026

Team Planner Relay ("the app") is a free, open-source (MIT) planning app for Jira Cloud, built and run on Atlassian Forge.
It is made by Vedran Vukosav as a private individual ("the developer").

## Summary

- The app runs entirely on Atlassian's platform (Atlassian Forge, "Runs on Atlassian"). It has no servers of its own.
- Data the app stores stays in Atlassian-hosted Forge storage, inside your site's installation of the app.
- The app sends no data to the developer or to any third party. It has no analytics, tracking, cookies or ads.
- The developer cannot read your planning data.

## What the app reads

The app reads Jira issues from the projects an administrator connected: when a team manager presses *Refresh* (with that
person's Jira access) and automatically every few minutes when issues changed (with the app's access). It reads issue key, summary, type, components,
labels, assignee, original estimate, story points, issue links, time spent and resolution date. For timesheets it reads the
work logs team members logged on those issues. When an administrator adds team members, the app searches Jira users by name.

## What the app stores

In Forge storage, inside your installation:
- **Team settings:** people's display names, Jira account IDs, job titles, roles in the app and skills; projects, task types and estimation rules.
- **Planning data:** tasks (including Jira issue keys and summaries), estimates, assignments, blockers, agreed dates, private-time labels, absences and shared project notes.
- **Estimation history:** hours spent on finished tasks, with no personal details.

Timesheets are not stored by the app: time is logged as Jira work logs, which Jira stores and controls. The app only writes to Jira
when a person logs, edits or deletes their own time, or a team manager sets an issue's assignee or due date.

## Who can see it

Access is decided by your site's administrators in the app's settings and enforced by the app:
- Team members see their own assignments and timesheets.
- Team managers see the team plan and the team's logged time, but not work log comments in Relay.
- Project managers see their projects' outlook, and only the issue titles Jira lets them browse.
- Private-time labels are visible only to their owner. Work log comments are visible in Jira to anyone who can see the issue.

## Logs

If the app hits an unexpected error, it writes a technical error message to Atlassian's app logs. These logs are meant for fixing bugs
and the app does not deliberately put planning data in them. Atlassian's rules decide when the developer may view logs from your site.

## Keeping and deleting data

Data stays until an administrator removes it in the app or uninstalls the app. After uninstalling, Atlassian deletes the app's stored
data according to Atlassian's Forge data retention policy. When someone leaves, an administrator can use *Remove personal data* in the app's
settings: it deletes their name, Jira link, private time and absences. Their Jira work logs are managed in Jira.

## Atlassian

Hosting, storage and security of the platform are provided by Atlassian under Atlassian's own terms and privacy policy:
https://www.atlassian.com/legal/privacy-policy

## Contact

Questions or requests: open an issue at https://github.com/corpusculus/team-planner-relay/issues
