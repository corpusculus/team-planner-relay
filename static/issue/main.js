// Jira issue panel: how Relay plans this issue. The backend reads the issue from Forge's context.
import { call } from '../common/backend.js';
import { $, esc } from '../common/ui.js';

call('issuePlan').then(r => {
  if (!r.planned) { $('view').innerHTML = '<p class="sub">This issue is not in a Relay team plan. It appears once its project is connected in Relay settings and the plan is refreshed.</p>'; return; }
  const row = (label, value) => (value ? '<dt>' + label + '</dt><dd>' + esc(value) + '</dd>' : '');
  $('view').innerHTML = '<span class="td-status s-' + r.status.toLowerCase().replace(/ /g, '-') + '">' + esc(r.status) + '</span><dl>' +
    row('Planned for', r.owner) + row('When', r.window) + row('Waiting for', r.waiting) + row('Effort', r.work + ' + ' + r.buffer + ' buffer') +
    row('Project', r.project) + row('Project forecast', r.projectForecast + (r.due && r.due !== 'No date' ? ' · requested ' + r.due : '')) + row('Team', r.team) + '</dl>';
}, e => { $('view').innerHTML = '<p class="late">' + esc(e.message) + '</p>'; });
