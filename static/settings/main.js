// Relay settings (Jira admin page): planning units, task types, estimation, people, projects and Jira mapping.
import { estimate, multiplier, toSlots } from '../../src/shared/estimate.js';
import { call, isLocal, session } from '../common/backend.js';
import { $, esc, options, modal } from '../common/ui.js';
import { rulesHtml } from '../common/rules.js';
import { leaveMode, LEAVE_REASONS } from '../../src/shared/model.js';

let teams = [], saved, s, meta, dirty = false, tab = 'start', openCards = new Set(), jiraProjects = [], search = { target: null, query: '', users: [] }, trial = { type: 0, p: 0, s: 0 };

const status = (text, error = false) => { $('status').textContent = text; $('status').className = 'grow ' + (error ? 'late' : 'sub'); };
// Save and Discard are only live while there is something to save.
const syncSave = () => { $('save').disabled = $('discard').disabled = !dirty; };
const markDirty = () => { dirty = true; syncSave(); status('Unsaved changes'); };

async function load() {
  try {
    teams = (await call('listTeams')).teams;
    if (!teams.some(t => t.id === session.team)) session.team = teams[0].id;
    meta = await call('getSettings');
    saved = meta.settings; saved.general.absenceIssues ??= {}; s = structuredClone(saved); dirty = false;
    if (!s.demo && meta.jira) jiraProjects = (await call('jiraProjects')).projects;
    render(); status(meta.refreshedAt ? 'Jira refreshed ' + new Date(meta.refreshedAt).toLocaleString('en-GB') : '');
  } catch (e) { $('view').innerHTML = '<div class="error-panel">' + esc(e.message) + '</div>'; }
}

// ---- small form helpers; data-path is a dotted path into the settings object ----
const text = (path, value, attrs = '') => '<input data-path="' + path + '" value="' + esc(value) + '" ' + attrs + '>';
const num = (path, value, attrs = '') => '<input type="number" data-path="' + path + '" data-num value="' + esc(value) + '" ' + attrs + '>';
const sel = (path, items, value, attrs = '') => '<select data-path="' + path + '" ' + attrs + '>' + options(items, value) + '</select>';
const bool = (path, value, label) => '<label><input type="checkbox" data-path="' + path + '" data-bool ' + (value ? 'checked' : '') + '> ' + label + '</label>';
// Every field is label / control / hint, so the CSS can line rows up regardless of text length.
const field = (label, input, hint = '', cls = '') => '<label class="field ' + cls + '"><span class="field-label">' + label + '</span>' + input + '<span class="hint">' + hint + '</span></label>';
// A field holding several controls (checkbox groups) must not be a <label>, or clicking its title toggles the first box.
const group = (label, inner, hint = '', cls = '') => '<div class="field ' + cls + '"><span class="field-label">' + label + '</span>' + inner + '<span class="hint">' + hint + '</span></div>';
/** A person, project or task type: a one-line summary until opened for editing. */
const card = (key, title, summary, head, body, archived) => openCards.has(key)
  ? '<div class="card' + (archived ? ' archived' : '') + '"><div class="card-head">' + head + '<button type="button" data-card="' + key + '">Done</button></div>' + body + '</div>'
  : '<div class="card' + (archived ? ' archived' : '') + '"><div class="card-row"><div class="card-sum"><b>' + esc(title) + '</b><span class="hint">' + esc(summary) + '</span></div><button type="button" data-card="' + key + '" aria-label="Edit ' + esc(title) + '">Edit</button></div></div>';
const TABS = [['start', 'Start'], ['people', 'People'], ['projects', 'Projects'], ['types', 'Task types'], ['estimation', 'Estimation'], ['calendar', 'Calendar'], ['rules', 'Planning rules']];
const ROLE = { member: 'Team member', team: 'Team manager', pm: 'Project manager' }, WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const many = (path, list, chosen) => '<div class="checks">' + list.map(([v, l]) => '<label><input type="checkbox" data-toggle="' + path + '" value="' + esc(v) + '" ' + (chosen.map(String).includes(String(v)) ? 'checked' : '') + '>' + esc(l) + '</label>').join('') + '</div>';
const panel = (title, intro, body) => '<section class="panel"><div class="section-head"><div><h2>' + title + '</h2><p>' + intro + '</p></div></div><div class="content">' + body + '</div></section>';
// rows are arrays of cell HTML; data-label lets phones show each row as a labelled block.
const table = (heads, rows) => '<div class="scroll"><table class="data stack"><thead><tr>' + heads.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + rows.map(cells => '<tr>' + cells.map((c, k) => '<td data-label="' + esc(heads[k]) + '">' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
const systemsList = () => s.systems.map((n, i) => [i, n]);
const peopleList = () => s.people.map((p, i) => [i, p.name + (p.archived ? ' (archived)' : '')]);

function setPath(path, value) {
  const keys = path.split('.'), last = keys.pop();
  const target = keys.reduce((o, k) => o[k], s);
  target[last] = value;
}
function getPath(path) { return path.split('.').reduce((o, k) => o[k], s); }

function render() {
  const g = s.general;
  syncSave();
  $('plannerLink').hidden = !isLocal;
  $('teamPick').hidden = teams.length < 2; $('teamPick').innerHTML = options(teams.map(t => [t.id, t.name]), session.team);
  const team = s.people.filter(p => !p.archived), linked = team.filter(p => p.accountId).length, connected = s.projects.filter(p => p.jiraKey && !p.archived).length;
  const step = (done, title, detail, action) => '<div class="step' + (done ? ' complete' : '') + '"><span class="step-mark" aria-hidden="true">' + (done ? '✓' : '') + '</span><div class="step-text"><b>' + title + '</b><span class="hint">' + detail + '</span></div>' + action + '</div>';
  const go = (k, label) => '<button type="button" data-tab="' + k + '">' + label + ' →</button>';
  const start = panel('Set up Relay', s.demo ? 'You are looking at the fictional demo team. Start with Switch to live: adding your Jira users and connecting Jira projects become available after it. Until then People and Projects only hold the demo.' : 'Everything Relay needs, in order. Estimation and Calendar have sensible defaults.',
    step(!s.demo, 'Use live Jira data', s.demo ? 'Demo data is shown now.' : 'Relay plans issues from your Jira projects.', '<button id="switchMode"' + (s.demo ? ' class="primary"' : '') + '>' + (s.demo ? 'Switch to live…' : 'Back to demo…') + '</button>') +
    // Demo data never ticks a step: it read as if setup were done and only Switch to live were left.
    step(!s.demo && team.length && linked === team.length, 'Add your team', s.demo ? 'After switching to live: add your Jira users, with roles, skills and working days.' : team.length + ' people, ' + linked + ' linked to Jira. Roles, skills and working days.', go('people', 'People')) +
    step(!s.demo && connected, 'Connect projects', s.demo ? 'After switching to live: connect your Jira projects, with lead, backup and project managers.' : connected + ' Jira projects connected. Lead, backup and project managers.', go('projects', 'Projects')) +
    step(!s.demo && s.types.some(t => !t.archived && (t.issueTypes || t.components || t.labels)), 'Check task types', 'How Jira issues become tasks' + (s.demo ? '.' : ' · ' + (meta.unmappedTotal ?? 0) + ' issues need mapping.'), go('types', 'Task types')) +
    step(!s.demo && !!meta.refreshedAt, 'Refresh from Jira', meta.refreshedAt ? 'Last refreshed ' + new Date(meta.refreshedAt).toLocaleString('en-GB') + '. Then every 5 minutes automatically.' : s.demo ? 'Available after you switch to live Jira data.' : 'Reads the connected projects into the plan.', s.demo ? '' : '<button class="primary" id="refreshNow">↻ Refresh now</button>'));

  const general = panel('Calendar and time', 'Working hours, planning slots, public holidays and where internal time is logged. The defaults suit most teams.',
    '<div class="grid-form">' +
    field('Hours per workday', num('general.workdayHours', g.workdayHours, 'min="1" max="24" step="1"')) +
    field('Minimum slot (hours)', num('general.slotHours', g.slotHours, 'min="1" step="1"'), 'Must divide the workday. 4h = at most 2 tasks a day.') +
    field('Workday starts at', num('general.dayStartHour', g.dayStartHour, 'min="0" max="23" step="1"'), 'Used for slot labels only.') +
    field('Planning start (a Monday)', '<input type="date" data-path="general.planStart" value="' + esc(g.planStart) + '">', 'Week 1 of the calendar. Workdays are Monday–Friday.') +
    field('Internal work issue', text('general.internalIssue', g.internalIssue ?? '', 'placeholder="e.g. ADMIN-12"'), 'Jira issue where time for non-project work is logged.') +
    field('Members’ own time off', sel('general.memberLeave', [['off', 'Only the team manager changes it'], ['request', 'Members request, the team manager approves'], ['free', 'Members change it freely']], leaveMode(g)), 'Members add, reschedule and remove their time off from My calendar. The team manager can always change anyone’s.', 'full') +
    group('Time off in Jira', '<div class="checks">' + bool('general.absenceToJira', g.absenceToJira, 'Record time off taken as Jira work logs, so it is kept apart from customer work') + '</div>', g.absenceToJira ? 'Members record it from their timesheet once the day has come. Each kind of time off goes on its own issue below; a kind left empty uses the “no reason given” issue.' : 'Off: time off stays in Relay only. Turn it on once you have a Jira project for it.', 'full') +
    (g.absenceToJira ? ['none', ...LEAVE_REASONS].map(r => field(r === 'none' ? 'Time off (no reason given)' : r, text('general.absenceIssues.' + r, g.absenceIssues?.[r] ?? '', 'placeholder="e.g. ABS-' + (r === 'none' ? 1 : LEAVE_REASONS.indexOf(r) + 2) + '"'))).join('') : '') +
    group('Public holidays', '<div class="holiday-editor"><div class="link-row"><input type="date" id="holidayNew" aria-label="Holiday date"><button type="button" id="holidayAdd">Add holiday</button></div><div class="checks">' + (s.holidays ?? []).map((d, i) => '<span class="chip">' + esc(d) + '<button type="button" data-rm-holiday="' + i + '" aria-label="Remove ' + esc(d) + '">×</button></span>').join('') + '</div></div>', 'Nobody is planned on these days.', 'full') +
    '</div>');

  const estimation = panel('Estimation', 'How Relay sizes a task. History wins when there is enough of it; otherwise the type default is scaled by system size and complexity.',
    '<div class="grid-form">' +
    field('Estimate percentile', num('general.estimatePercentile', g.estimatePercentile, 'min="1" max="99"'), 'P70: 70% of similar tasks finished within the estimate.') +
    field('Buffer up to percentile', num('general.bufferPercentile', g.bufferPercentile, 'min="1" max="99"'), 'Buffer = P' + g.bufferPercentile + ' − P' + g.estimatePercentile + ' of history.') +
    field('Minimum finished tasks', num('general.minSamples', g.minSamples, 'min="1" max="50"'), 'Needed before history is used.') +
    field('History window (months)', num('general.historyMonths', g.historyMonths, 'min="1" max="60"')) +
    field('Story points field', text('general.storyPointsField', g.storyPointsField, 'placeholder="customfield_10016"'), 'Jira field id, for types that use story points.') +
    field('Dependency link type', text('general.blockLinkType', g.blockLinkType ?? 'Blocks'), 'Jira link that makes one issue wait for another.') +
    group('History from Jira', s.demo ? '<p class="hint">Available in live mode.</p>' : '<div class="checks"><button id="importHistory" type="button">Import finished issues</button></div>', s.demo ? '' : meta.completed.filter(c => c.source === 'jira').length + ' records from Jira time logs') +
    '</div><h3>System size levels</h3>' +
    table(['Code', 'Name', 'Multiplier', 'Default'], s.sizes.map((z, i) => [text('sizes.' + i + '.id', z.id, 'maxlength="8"'), text('sizes.' + i + '.name', z.name), num('sizes.' + i + '.multiplier', z.multiplier, 'step="0.05" min="0.1" max="10"'), '<input type="radio" name="defaultSize" aria-label="Default size" data-default-size="' + esc(z.id) + '" ' + (s.defaultSize === z.id ? 'checked' : '') + '>'])) +
    '<button data-add="size">＋ Add size level</button><h3>Complexity factors</h3>' +
    table(['Factor', 'Multiplier', 'Jira label'], s.factors.map((f, i) => [text('factors.' + i + '.name', f.name), num('factors.' + i + '.multiplier', f.multiplier, 'step="0.05" min="0.1" max="10"'), text('factors.' + i + '.label', f.label, 'placeholder="optional, e.g. vpn"')])) +
    '<button data-add="factor">＋ Add complexity factor</button><p class="hint">Turn factors on per project below, or per issue with the Jira label.</p>');

  const systems = panel('Systems', 'The skills a task needs. A Jira component with the same name sets the system of an issue.',
    '<div class="grid-form">' + s.systems.map((n, i) => field('System ' + (i + 1), text('systems.' + i, n))).join('') + '</div><button data-add="system">＋ Add system</button>');

  const sources = [['relay', 'Relay (history / size)'], ['jira-estimate', 'Jira estimate'], ['story-points', 'Story points']];
  const types = panel('Task types', 'Each type has a default effort and buffer, where its duration comes from, and the rules that match Jira issues to it. The first matching type wins. A type without rules is only used for tasks added in Relay.',
    s.types.map((t, i) => card('types:' + i, t.name, [s.systems[t.system], t.baseHours + 'h + ' + t.bufferHours + 'h buffer', Object.fromEntries(sources)[t.source], [t.issueTypes, t.components, t.labels].filter(Boolean).join(' / ') || 'no Jira rules', t.archived && 'archived'].filter(Boolean).join(' · '),
      text('types.' + i + '.name', t.name, 'aria-label="Task type name"') + bool('types.' + i + '.archived', t.archived, 'Archived'), '<div class="grid-form">' +
      field('System', sel('types.' + i + '.system', systemsList(), t.system, 'data-num')) +
      field('Base hours', num('types.' + i + '.baseHours', t.baseHours, 'min="0.5" step="0.5"')) +
      field('Buffer hours', num('types.' + i + '.bufferHours', t.bufferHours, 'min="0" step="0.5"')) +
      field('Duration from', sel('types.' + i + '.source', sources, t.source, 'data-rerender')) +
      field('Hours per story point', num('types.' + i + '.hoursPerPoint', t.hoursPerPoint, 'min="0.25" step="0.25"' + (t.source === 'story-points' ? '' : ' disabled')), t.source === 'story-points' ? '' : 'Only for story points') +
      field('Jira issue types', text('types.' + i + '.issueTypes', t.issueTypes, 'placeholder="Task, Story"'), 'Comma-separated') +
      field('Components', text('types.' + i + '.components', t.components, 'placeholder="any"'), 'Empty = any') +
      field('Labels', text('types.' + i + '.labels', t.labels, 'placeholder="any"'), 'Empty = any') +
      '</div>', t.archived)).join('') +
    '<button data-add="type">＋ Add task type</button>' + tryIt());

  const people = panel('People', s.demo ? 'The fictional demo team. Switch to live mode to add your Jira users and set who is who.' : 'Team members are Jira users. Role decides what they can see and change. Skills decide which systems they can cover.',
    (!s.demo ? '<div class="queue-tools"><span class="field-label">Add a Jira user</span>' + finder('new') + '</div>' : '<button data-add="person">＋ Add person</button>') +
    s.people.map((p, i) => card('people:' + i, p.name, [ROLE[p.access], p.skills.map(k => s.systems[k]).join(', ') || 'no skills', !s.demo && (p.accountId ? 'linked to Jira' : 'not linked to Jira'), (p.days ?? [0, 1, 2, 3, 4]).length < 5 && WEEK.filter((_, k) => (p.days ?? []).includes(k)).join(', '), (p.hoursPerDay ?? s.general.workdayHours) < s.general.workdayHours && p.hoursPerDay + 'h a day', p.access === 'pm' && (p.pmProjects ?? []).length + ' projects', p.archived && 'archived'].filter(Boolean).join(' · '),
      text('people.' + i + '.name', p.name, 'aria-label="Name"') + bool('people.' + i + '.archived', p.archived, 'Archived') + (i < saved.people.length ? '<button type="button" data-forget="' + i + '">Remove personal data…</button>' : ''), '<div class="grid-form">' +
      field('Job title', text('people.' + i + '.role', p.role)) +
      field('Role in Relay', sel('people.' + i + '.access', [['member', 'Team member'], ['team', 'Team manager'], ['pm', 'Project manager']], p.access, 'data-rerender')) +
      group('Jira user', s.demo ? '<p class="hint">Available in live mode.</p>' : p.accountId ? '<div class="link-row"><span class="linked">✓ Linked</span><button type="button" data-unlink="' + i + '">Unlink</button></div>' : finder(String(i)), s.demo ? '' : p.accountId ? 'Signs in to Relay as this person.' : 'Not linked: cannot open the planner.') +
      field('Hours per day', num('people.' + i + '.hoursPerDay', p.hoursPerDay ?? s.general.workdayHours, 'min="' + s.general.slotHours + '" max="' + s.general.workdayHours + '" step="' + s.general.slotHours + '"'), 'Part-time: fewer hours a day.') +
      group('Works on', many('people.' + i + '.days', [[0, 'Mon'], [1, 'Tue'], [2, 'Wed'], [3, 'Thu'], [4, 'Fri']], p.days ?? [0, 1, 2, 3, 4])) +
      group('Skills', many('people.' + i + '.skills', systemsList(), p.skills), '', 'full') +
      (p.access === 'pm' ? group('Projects they manage', many('people.' + i + '.pmProjects', s.projects.map((x, j) => [j, x.name]), p.pmProjects), '', 'full') : '') +
      '</div>', p.archived)).join(''));

  const projects = panel('Projects', 'Each Relay project maps to a Jira project, or to some of its components when several Relay projects share one Jira project. The lead and backup cover the systems in their skills. Set the size of each system and the complexity that applies.',
    (!s.demo ? '<div class="queue-tools"><label>Connect a Jira project ' + sel('', [['', jiraProjects.length ? 'Choose…' : 'No Jira projects visible'], ...jiraProjects.map(j => [j.key, j.name + ' (' + j.key + ')' + (s.projects.some(p => p.jiraKey === j.key) ? ' · connected, add again to split by component' : '')])], '', 'id="jiraPick"') + '</label><button id="jiraAdd">Connect</button></div>' : '<button data-add="project">＋ Add project</button>') +
    s.projects.map((p, i) => {
      const pms = s.people.map((x, j) => [x, j]).filter(([x]) => x.access === 'pm' && !x.archived);
      const covered = [...new Set([...(s.people[p.lead]?.skills ?? []), ...(s.people[p.back]?.skills ?? [])])];
      const pmNames = pms.filter(([x]) => (x.pmProjects ?? []).includes(i)).map(([x]) => x.name).join(', ');
      return card('projects:' + i, p.name, [p.jiraKey ? p.jiraKey + (p.components ? ' · ' + p.components : '') : s.demo ? null : 'no Jira key', 'lead ' + (s.people[p.lead]?.name ?? 'none'), p.back != null && 'backup ' + s.people[p.back]?.name, pmNames && 'PM ' + pmNames, p.due && 'due ' + p.due, p.archived && 'archived'].filter(Boolean).join(' · '),
        text('projects.' + i + '.name', p.name, 'aria-label="Project name"') + bool('projects.' + i + '.archived', p.archived, 'Archived'), '<div class="grid-form">' +
        field('Jira project key', text('projects.' + i + '.jiraKey', p.jiraKey, 'placeholder="e.g. PILOT"')) +
        field('Jira components (optional)', text('projects.' + i + '.components', p.components ?? '', 'placeholder="e.g. Acme, Acme portal"'), 'When several Relay projects share this Jira project: its issues with one of these components. Leave empty for all issues, or the rest.') +
        field('Due date', '<input type="date" data-path="projects.' + i + '.due" value="' + esc(p.due) + '">') +
        field('Lead', sel('projects.' + i + '.lead', [['', 'None'], ...peopleList()], p.lead, 'data-num data-rerender')) +
        field('Backup', sel('projects.' + i + '.back', [['', 'None'], ...peopleList()], p.back, 'data-num data-rerender')) +
        field('Custom JQL (optional)', text('projects.' + i + '.jql', p.jql, 'placeholder="project = &quot;' + esc(p.jiraKey || 'KEY') + '&quot; AND statusCategory != Done ORDER BY Rank ASC"'), 'Leave empty for all open issues in the project.', 'full') +
        (covered.length ? covered.map(sy => field('Size · ' + esc(s.systems[sy]), sel('projects.' + i + '.sizes.' + sy, s.sizes.map(z => [z.id, z.name + ' ×' + z.multiplier]), p.sizes[sy] ?? s.defaultSize))).join('') : group('System size', '<p class="hint">Choose a lead or backup with skills first.</p>', '', 'full')) +
        group('Project managers', pms.length ? '<div class="checks">' + pms.map(([x, j]) => '<label><input type="checkbox" data-pm-of="' + i + '" value="' + j + '" ' + ((x.pmProjects ?? []).includes(i) ? 'checked' : '') + '>' + esc(x.name) + '</label>').join('') + '</div>' : '<p class="hint">Set someone’s role to Project manager under People first.</p>', 'They see this project’s outlook, calendar and report.', 'full') +
        group('Complexity', many('projects.' + i + '.factors', s.factors.map(f => [f.id, f.name + ' ×' + f.multiplier]), p.factors), '', 'full') +
        '</div>', p.archived);
    }).join(''));

  const jiraUpdates = panel('Jira updates', 'What Relay writes to Jira on its own. Works in live mode, with the Jira permissions of the person making the change.',
    '<div class="grid-form">' +
    field('Status when work starts', text('general.startStatus', g.startStatus ?? '', 'placeholder="e.g. In Progress"'), 'Jira status name. Empty: Relay leaves the status alone.') +
    field('Status when work finishes', text('general.doneStatus', g.doneStatus ?? '', 'placeholder="e.g. Done"'), 'Used when someone records the finish.') +
    group('Tell people about plan changes', '<div class="checks">' + bool('general.notifyChanges', g.notifyChanges, 'Comment on a Jira issue when its planned owner changes or its finish moves later') + '</div>', 'The comment mentions the new and previous owner, so Jira notifies them. At most 20 issues per change.', 'full') +
    '</div>');
  const teamPanel = panel('Teams', 'Each team has its own people, projects, plan and settings. People open the teams they are on.',
    '<div class="grid-form">' + field('This team’s name', '<div class="link-row"><input id="teamName" maxlength="60" value="' + esc(teams.find(t => t.id === session.team)?.name ?? '') + '"><button type="button" id="teamRename">Rename</button></div>') +
    field('Add a team', '<div class="link-row"><input id="teamNew" maxlength="60" placeholder="Team name"><button type="button" id="teamAdd">Add team</button></div>', 'A new team starts with the demo data. Switch it to live under Set up Relay.') + '</div>');
  const unmapped = s.demo ? '' : panel('Needs mapping', 'Jira issues from the last refresh that Relay could not plan. Fix a task type rule, a component, or a project contact, then refresh.',
    meta.unmapped.length ? (meta.unmappedTotal > meta.unmapped.length ? '<p class="hint">Showing ' + meta.unmapped.length + ' of ' + meta.unmappedTotal + '.</p>' : '') + table(['Issue', 'Project', 'Reason'], meta.unmapped.map(u => ['<b>' + esc(u.key) + '</b> ' + esc(u.summary), esc(u.project), esc(u.reason)])) : '<p class="empty">Nothing to map.</p>');

  const sections = { start: start + unmapped + jiraUpdates + teamPanel, people, projects, types: types + systems, estimation, calendar: general, rules: rulesHtml(s, !s.demo && meta.jira) };
  $('view').innerHTML = '<nav class="section-tabs" aria-label="Settings sections">' + TABS.map(([k, l]) => '<button type="button" class="tab' + (k === tab ? ' active' : '') + '" data-tab="' + k + '" aria-current="' + (k === tab ? 'page' : 'false') + '">' + l + '</button>').join('') + '</nav>' + sections[tab];
}

/** Live estimate preview so admins can see what the numbers produce before saving. */
function tryIt() {
  return '<h3>Try an estimate</h3><div class="grid-form">' +
    field('Task type', '<select data-trial="type">' + options(s.types.map((t, i) => [i, t.name]), trial.type) + '</select>') +
    field('Project', '<select data-trial="p">' + options(s.projects.map((p, i) => [i, p.name]), trial.p) + '</select>') +
    field('System', '<select data-trial="s">' + options(systemsList(), trial.s) + '</select>') +
    '</div><div class="result" id="trialResult">' + trialResult() + '</div>';
}
function trialResult() {
  const valid = s.types[trial.type] && s.projects[trial.p] && s.systems[trial.s] !== undefined;
  let result = 'Choose a type, project and system.';
  if (valid) {
    try {
      const e = estimate(s, { type: trial.type, p: trial.p, s: trial.s }, meta.completed, meta.today), slot = s.general.slotHours;
      const m = multiplier(s, trial.p, trial.s);
      result = '<b>' + toSlots(e.hours, slot) * slot + 'h + ' + toSlots(e.buffer, slot) * slot + 'h buffer</b> (raw ' + e.hours.toFixed(1) + 'h + ' + e.buffer.toFixed(1) + 'h, rounded up to ' + slot + 'h slots)<br><span class="sub">' + esc(e.source) + ' · size × complexity = ' + m.value.toFixed(2) + '</span>';
    } catch (err) { result = esc(err.message); }
  }
  return result;
}

/** Jira user search box; `target` is 'new' (add a person) or a person index (link that person). */
function finder(target) {
  const hit = search.target === target;
  return '<div class="link-row"><input id="find-' + target + '" placeholder="Name or email" autocomplete="off" value="' + esc(hit ? search.query : '') + '"><button type="button" data-find="' + target + '">Find</button>' +
    (hit && search.users.length ? '<select id="pick-' + target + '" aria-label="Jira user">' + options(search.users.map((u, k) => [k, u.name]), 0) + '</select><button type="button" class="primary" data-pick="' + target + '">' + (target === 'new' ? 'Add' : 'Link') + '</button>' : '') + '</div>';
}

const blank = {
  size: () => ({ id: 'S' + (s.sizes.length + 1), name: 'New size', multiplier: 1 }),
  factor: () => ({ id: 'f' + crypto.randomUUID().slice(0, 8), name: 'New factor', multiplier: 1.1, label: '' }),
  system: () => 'New system',
  type: () => ({ name: 'New task type', system: 0, baseHours: 8, bufferHours: 4, source: 'relay', hoursPerPoint: 4, issueTypes: '', components: '', labels: '', archived: false }),
  person: () => ({ name: 'New person', role: '', access: 'member', skills: [], accountId: null, pmProjects: [], archived: false, days: [0, 1, 2, 3, 4], hoursPerDay: s.general.workdayHours }),
  project: () => ({ name: 'New project', jiraKey: '', components: '', jql: '', due: '', lead: null, back: null, sizes: {}, factors: [], archived: false })
};
const listOf = { size: 'sizes', factor: 'factors', system: 'systems', type: 'types', person: 'people', project: 'projects' };

document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.trial !== undefined) return;
  if (t.dataset.path) {
    const v = t.dataset.bool !== undefined ? t.checked : t.dataset.num !== undefined ? (t.value === '' ? null : Number(t.value)) : t.value;
    setPath(t.dataset.path, v); markDirty();
    if (t.dataset.rerender !== undefined || t.type === 'checkbox') render();
    else if ($('trialResult')) $('trialResult').innerHTML = trialResult();
  }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.trial) { trial[t.dataset.trial] = Number(t.value); render(); return; }
  if (t.dataset.toggle) {
    const list = getPath(t.dataset.toggle), v = /^\d+$/.test(t.value) ? Number(t.value) : t.value;
    setPath(t.dataset.toggle, t.checked ? [...new Set([...list, v])] : list.filter(x => x !== v)); markDirty(); render();
  }
  if (t.dataset.pmOf !== undefined) {
    const proj = Number(t.dataset.pmOf), person = s.people[Number(t.value)];
    person.pmProjects = t.checked ? [...new Set([...(person.pmProjects ?? []), proj])] : (person.pmProjects ?? []).filter(x => x !== proj);
    markDirty(); render();
  }
  if (t.dataset.defaultSize) { s.defaultSize = t.dataset.defaultSize; markDirty(); }
  if (t.tagName === 'SELECT' && t.dataset.path && t.dataset.rerender === undefined) render(); // keep estimate preview current
});
document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.hasAttribute('data-dismiss')) $('modal').close();
  if (b.dataset.tab) { tab = b.dataset.tab; render(); window.scrollTo(0, 0); }
  if (b.dataset.card) { openCards.has(b.dataset.card) ? openCards.delete(b.dataset.card) : openCards.add(b.dataset.card); render(); }
  if (b.dataset.add) { const list = listOf[b.dataset.add]; s[list].push(blank[b.dataset.add]()); openCards.add(list + ':' + (s[list].length - 1)); markDirty(); render(); }
  if (b.id === 'switchMode') modal(s.demo ? 'Switch to live Jira data?' : 'Switch back to demo data?', '<p>' + (s.demo ? 'The demo team, projects and plan are removed. Your systems, task types, sizes and factors are kept. Then add your Jira users and connect Jira projects.' : 'The live plan and Relay-only records (timesheets, private time, blockers) are removed and replaced with the demo. Jira itself is not changed.') + '</p><div class="actions"><button data-dismiss>Cancel</button><button class="primary" id="confirmSwitch">Switch</button></div>');
  if (b.id === 'confirmSwitch') { $('modal').close(); await run(() => call('saveSettings', { switchMode: true }), 'Mode switched.'); if (!s.demo && meta.jira) { jiraProjects = (await call('jiraProjects')).projects; render(); } }
  if (b.id === 'refreshNow') {
    if (dirty) return status('Save settings before refreshing.', true);
    status('Reading Jira…');
    try { await call('refresh'); await load(); status('Refreshed from Jira. ' + meta.unmapped.length + ' issues need mapping.'); } catch (err) { status(err.message, true); }
  }
  if (b.id === 'importHistory') {
    if (dirty) return status('Save settings before importing.', true);
    status('Reading finished issues from Jira…');
    try { const r = await call('importHistory'); await load(); status('Imported ' + r.imported + ' finished issues.'); } catch (err) { status(err.message, true); }
  }
  if (b.id === 'teamAdd' || b.id === 'teamRename') {
    if (dirty) return status('Save or discard your changes first.', true);
    try {
      const add = b.id === 'teamAdd', r = await call(add ? 'addTeam' : 'renameTeam', { name: $(add ? 'teamNew' : 'teamName').value });
      teams = r.teams;
      if (add) { session.team = teams.at(-1).id; tab = 'start'; await load(); status('Team added. You are now editing ' + teams.at(-1).name + '.'); } else { render(); status('Team renamed.'); }
    } catch (err) { status(err.message, true); }
  }
  if (b.id === 'save') await run(() => call('saveSettings', { settings: s }), 'Settings saved.');
  if (b.id === 'discard') { s = structuredClone(saved); dirty = false; render(); status('Changes discarded.'); }
  if (b.dataset.find !== undefined) {
    const target = b.dataset.find, query = $('find-' + target).value;
    try { search = { target, query, users: (await call('searchUsers', { query })).users }; render(); if (!search.users.length) status('No Jira users found for “' + query + '”.', true); } catch (err) { status(err.message, true); }
  }
  if (b.dataset.pick !== undefined) {
    const target = b.dataset.pick, u = search.users[Number($('pick-' + target).value)];
    if (!u) return;
    const other = s.people.findIndex(p => p.accountId === u.accountId);
    if (other >= 0 && String(other) !== target) return status(u.name + ' is already linked to ' + s.people[other].name + '.', true);
    if (target === 'new') { s.people.push({ ...blank.person(), name: u.name, accountId: u.accountId }); openCards.add('people:' + (s.people.length - 1)); }
    else Object.assign(s.people[Number(target)], { accountId: u.accountId }, s.people[Number(target)].name === 'New person' ? { name: u.name } : {});
    search = { target: null, query: '', users: [] }; markDirty(); render();
  }
  if (b.id === 'holidayAdd') {
    const d = $('holidayNew').value;
    if (!d) return status('Choose a date first.', true);
    s.holidays = [...new Set([...(s.holidays ?? []), d])].sort(); markDirty(); render();
  }
  if (b.dataset.rmHoliday !== undefined) { s.holidays.splice(Number(b.dataset.rmHoliday), 1); markDirty(); render(); }
  if (b.dataset.forget !== undefined) {
    if (dirty) return status('Save or discard your changes first.', true);
    const i = Number(b.dataset.forget);
    modal('Remove ' + s.people[i].name + '’s personal data?', '<p>For someone who has left. Their name, Jira link, private time and absences are removed and they are archived. Work already recorded in the plan stays, without their name.' + (meta.jira ? ' Their Jira work logs stay in Jira; remove those in Jira if needed.' : '') + '</p><p>This cannot be undone.</p><div class="actions"><button data-dismiss>Cancel</button><button class="primary" data-forget-confirm="' + i + '">Remove personal data</button></div>');
  }
  if (b.dataset.forgetConfirm !== undefined) { $('modal').close(); await run(() => call('forgetPerson', { index: Number(b.dataset.forgetConfirm) }), 'Personal data removed.'); }
  if (b.dataset.unlink !== undefined) { s.people[Number(b.dataset.unlink)].accountId = null; markDirty(); render(); }
  if (b.id === 'jiraAdd') {
    const j = jiraProjects.find(x => x.key === $('jiraPick').value);
    if (j) { s.projects.push({ ...blank.project(), name: j.name, jiraKey: j.key }); openCards.add('projects:' + (s.projects.length - 1)); markDirty(); render(); }
  }
});
async function run(fn, message) {
  try { meta = await fn(); saved = meta.settings; saved.general.absenceIssues ??= {}; s = structuredClone(saved); dirty = false; render(); status(message); }
  catch (err) { status(err.message, true); }
}
$('close').onclick = () => $('modal').close();
$('teamPick').onchange = async () => {
  if (dirty) { $('teamPick').value = session.team; return status('Save or discard your changes first.', true); }
  session.team = $('teamPick').value; openCards.clear(); await load();
};
$('plannerLink').onclick = () => { location.href = '../planner/'; };
window.addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });

load();
