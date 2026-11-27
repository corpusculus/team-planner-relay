// Jira gives an app one page, and its admin pages are for Jira admins only, so team managers open settings here (#settings).
if (location.hash === '#settings') import('../settings/main.js'); else import('./main.js');
