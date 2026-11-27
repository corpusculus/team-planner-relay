// Jira gives an app one page, and its admin pages are for Jira admins only, so team managers open settings here (#settings).
// Clear the planner's own "Loading the plan…" first, so settings show a single loading screen.
if (location.hash === '#settings') { document.body.replaceChildren(); import('../settings/main.js'); } else import('./main.js');
