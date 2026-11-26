// Relay settings (Jira admin page): planning units, task types, estimation, people, projects and Jira mapping.
import { estimate, multiplier, toSlots } from '../../src/shared/estimate.js';
import { call, isLocal } from '../common/backend.js';

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let saved, s, meta, dirty = false, jiraProjects = [], userResults = [], trial = { type: 0, p: 0, s: 0 };

const status = (text, error = false) => { $('status').textContent = text; $('status').className = 'grow ' + (error ? 'late' : 'sub'); };
const markDirty = () => { dirty = true; status('Unsaved changes'); };

async function load() {
  try {
    meta = await call('getSettings');
    saved = meta.settings; s = structuredClone(saved); dirty = false;
    if (!s.demo && meta.jira) jiraProjects = (await call('jiraProjects')).projects;
    render(); status(meta.refreshedAt ? 'Jira refreshed ' + new Date(meta.refreshedAt).toLocaleString('en-GB') : '');
  } catch (e) { $('view').innerHTML = '<div class="error-panel">' + esc(e.message) + '</div>'; }
}

// ---- small form helpers; data-path is a dotted path into the settings object ----
const opts = (items, value) => items.map(([v, l]) => '<option value="' + esc(v) + '"' + (String(v) === String(value ?? '') ? ' selected' : '') + '>' + esc(l) + '</option>').join('');
const text = (path, value, attrs = '') => '<input data-path="' + path + '" value="' + esc(value) + '" ' + attrs + '>';
const num = (path, value, attrs = '') => '<input type="number" data-path="' + path + '" data-num value="' + esc(value) + '" ' + attrs + '>';
const sel = (path, items, value, attrs = '') => '<select data-path="' + path + '" ' + attrs + '>' + opts(items, value) + '</select>';
const bool = (path, value, label) => '<label><input type="checkbox" data-path="' + path + '" data-bool ' + (value ? 'checked' : '') + '> ' + label + '</label>';
const field = (label, input, hint = '') => '<label class="field">' + label + input + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</label>';
const many = (path, list, chosen) => '<div class="checks">' + list.map(([v, l]) => '<label><input type="checkbox" data-toggle="' + path + '" value="' + esc(v) + '" ' + (chosen.map(String).includes(String(v)) ? 'checked' : '') + '>' + esc(l) + '</label>').join('') + '</div>';
const panel = (title, intro, body) => '<section class="panel"><div class="section-head"><div><h2>' + title + '</h2><p>' + intro + '</p></div></div><div class="content">' + body + '</div></section>';
const table = (heads, rows) => '<div class="scroll"><table class="data"><thead><tr>' + heads.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
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
  $('plannerLink').hidden = !isLocal;
  const mode = panel('Mode', s.demo ? 'Relay is showing the fictional demo team. Switch to live to plan real Jira work.' : 'Relay plans issues from the connected Jira projects.',
    '<div class="modebox"><span class="badge">' + (s.demo ? 'DEMO' : 'LIVE') + '</span><button id="switchMode">' + (s.demo ? 'Switch to live Jira data…' : 'Switch back to demo data…') + '</button>' + (!s.demo ? '<button class="primary" id="refreshNow">↻ Refresh from Jira now</button>' : '') + '</div>');

  const general = panel('Planning units', 'Everything is stored in hours and planned in slots. A slot is the smallest piece of work a person gets.',
    '<div class="grid-form">' +
    field('Hours per workday', num('general.workdayHours', g.workdayHours, 'min="1" max="24" step="1"')) +
    field('Minimum slot (hours)', num('general.slotHours', g.slotHours, 'min="1" step="1"'), 'Must divide the workday. 4h = at most 2 tasks a day.') +
    field('Workday starts at', num('general.dayStartHour', g.dayStartHour, 'min="0" max="23" step="1"'), 'Used for slot labels only.') +
    field('Planning start (a Monday)', '<input type="date" data-path="general.planStart" value="' + esc(g.planStart) + '">', 'Week 1 of the calendar. Workdays are Monday–Friday.') +
    '</div>');

  const estimation = panel('Estimation', 'How Relay sizes a task. History wins when there is enough of it; otherwise the type default is scaled by system size and complexity.',
    '<div class="grid-form">' +
    field('Estimate percentile', num('general.estimatePercentile', g.estimatePercentile, 'min="1" max="99"'), 'P70: 70% of similar tasks finished within the estimate.') +
    field('Buffer up to percentile', num('general.bufferPercentile', g.bufferPercentile, 'min="1" max="99"'), 'Buffer = P' + g.bufferPercentile + ' − P' + g.estimatePercentile + ' of history.') +
    field('Minimum finished tasks', num('general.minSamples', g.minSamples, 'min="1" max="50"'), 'Needed before history is used.') +
    field('History window (months)', num('general.historyMonths', g.historyMonths, 'min="1" max="60"')) +
    field('Story points field', text('general.storyPointsField', g.storyPointsField, 'placeholder="customfield_10016"'), 'Jira field id, for types that use story points.') +
    '<div class="field">History from Jira<div class="checks">' + bool('general.jiraHistory', g.jiraHistory, 'Use time spent on done Jira issues') + '</div></div>' +
    '</div><h3>System size levels</h3>' +
    table(['Code', 'Name', 'Multiplier', 'Default'], s.sizes.map((z, i) => '<tr><td>' + text('sizes.' + i + '.id', z.id, 'maxlength="8"') + '</td><td>' + text('sizes.' + i + '.name', z.name) + '</td><td>' + num('sizes.' + i + '.multiplier', z.multiplier, 'step="0.05" min="0.1" max="10"') + '</td><td><input type="radio" name="defaultSize" data-default-size="' + esc(z.id) + '" ' + (s.defaultSize === z.id ? 'checked' : '') + '></td></tr>')) +
    '<button data-add="size">＋ Add size level</button><h3>Complexity factors</h3>' +
    table(['Factor', 'Multiplier', 'Jira label that switches it on'], s.factors.map((f, i) => '<tr><td>' + text('factors.' + i + '.name', f.name) + '</td><td>' + num('factors.' + i + '.multiplier', f.multiplier, 'step="0.05" min="0.1" max="10"') + '</td><td>' + text('factors.' + i + '.label', f.label, 'placeholder="optional, e.g. vpn"') + '</td></tr>')) +
    '<button data-add="factor">＋ Add complexity factor</button><p class="hint">Turn factors on per project below, or per issue with the Jira label.</p>');

  const systems = panel('Systems', 'The skills a task needs. A Jira component with the same name sets the system of an issue.',
    '<div class="grid-form">' + s.systems.map((n, i) => field('System ' + (i + 1), text('systems.' + i, n))).join('') + '</div><button data-add="system">＋ Add system</button>');

  const sources = [['relay', 'Relay estimate (history / size)'], ['jira-estimate', 'Jira original estimate'], ['story-points', 'Story points × hours']];
  const types = panel('Task types', 'Each type has a default effort and buffer, where its duration comes from, and the rules that match Jira issues to it. The first matching type wins. A type without rules is only used for tasks added in Relay.',
    table(['Name', 'System', 'Base h', 'Buffer h', 'Duration from', 'h / point', 'Jira issue types', 'Components', 'Labels', ''], s.types.map((t, i) => '<tr class="' + (t.archived ? 'archived' : '') + '"><td>' + text('types.' + i + '.name', t.name, 'style="min-width:190px"') + '</td><td>' + sel('types.' + i + '.system', systemsList(), t.system, 'data-num style="min-width:120px"') + '</td><td>' + num('types.' + i + '.baseHours', t.baseHours, 'min="0.5" step="0.5"') + '</td><td>' + num('types.' + i + '.bufferHours', t.bufferHours, 'min="0" step="0.5"') + '</td><td>' + sel('types.' + i + '.source', sources, t.source, 'data-rerender style="min-width:190px"') + '</td><td>' + (t.source === 'story-points' ? num('types.' + i + '.hoursPerPoint', t.hoursPerPoint, 'min="0.25" step="0.25"') : '—') + '</td><td>' + text('types.' + i + '.issueTypes', t.issueTypes, 'placeholder="Task, Story"') + '</td><td>' + text('types.' + i + '.components', t.components, 'placeholder="any"') + '</td><td>' + text('types.' + i + '.labels', t.labels, 'placeholder="any"') + '</td><td>' + bool('types.' + i + '.archived', t.archived, 'Archived') + '</td></tr>')) +
    '<button data-add="type">＋ Add task type</button>' + tryIt());

  const people = panel('People', s.demo ? 'The fictional demo team. In live mode you add Jira users here.' : 'Team members are Jira users. Role decides what they can see and change. Skills decide which systems they can cover.',
    (!s.demo ? '<div class="queue-tools"><label>Add a Jira user <input id="userQuery" placeholder="Name or email" autocomplete="off"></label><button id="userSearch">Search</button>' + (userResults.length ? sel('', userResults.map((u, i) => [i, u.name]), '', 'id="userPick"') + '<button id="userAdd">Add</button>' : '') + '</div>' : '<button data-add="person">＋ Add person</button>') +
    table(['Name', 'Job title', 'Role', 'Skills', 'Projects (PM)', ''], s.people.map((p, i) => '<tr class="' + (p.archived ? 'archived' : '') + '"><td>' + text('people.' + i + '.name', p.name) + (p.accountId ? '<span class="hint">Jira user</span>' : '') + '</td><td>' + text('people.' + i + '.role', p.role) + '</td><td>' + sel('people.' + i + '.access', [['member', 'Team member'], ['team', 'Team manager'], ['pm', 'Project manager']], p.access, 'data-rerender') + '</td><td>' + many('people.' + i + '.skills', systemsList(), p.skills) + '</td><td>' + (p.access === 'pm' ? many('people.' + i + '.pmProjects', s.projects.map((x, j) => [j, x.name]), p.pmProjects) : '—') + '</td><td>' + bool('people.' + i + '.archived', p.archived, 'Archived') + '</td></tr>')));

  const projects = panel('Projects', 'Each Relay project maps to one Jira project. The lead and backup cover the systems in their skills. Set the size of each system and the complexity that applies.',
    (!s.demo ? '<div class="queue-tools"><label>Connect a Jira project ' + sel('', [['', jiraProjects.length ? 'Choose…' : 'No Jira projects visible'], ...jiraProjects.filter(j => !s.projects.some(p => p.jiraKey === j.key)).map(j => [j.key, j.name + ' (' + j.key + ')'])], '', 'id="jiraPick"') + '</label><button id="jiraAdd">Connect</button></div>' : '<button data-add="project">＋ Add project</button>') +
    s.projects.map((p, i) => {
      const covered = [...new Set([...(s.people[p.lead]?.skills ?? []), ...(s.people[p.back]?.skills ?? [])])];
      return '<div class="card ' + (p.archived ? 'archived' : '') + '"><div class="card-head">' + text('projects.' + i + '.name', p.name) + bool('projects.' + i + '.archived', p.archived, 'Archived') + '</div><div class="grid-form">' +
        field('Jira project key', text('projects.' + i + '.jiraKey', p.jiraKey, 'placeholder="e.g. PILOT"')) +
        field('Due date', '<input type="date" data-path="projects.' + i + '.due" value="' + esc(p.due) + '">') +
        field('Lead', sel('projects.' + i + '.lead', [['', 'None'], ...peopleList()], p.lead, 'data-num data-rerender')) +
        field('Backup', sel('projects.' + i + '.back', [['', 'None'], ...peopleList()], p.back, 'data-num data-rerender')) +
        '</div>' + field('Custom JQL (optional)', text('projects.' + i + '.jql', p.jql, 'placeholder="project = &quot;' + esc(p.jiraKey || 'KEY') + '&quot; AND statusCategory != Done ORDER BY Rank ASC"'), 'Leave empty for all open issues in the project.') +
        '<h3>System size</h3><div class="grid-form">' + (covered.length ? covered.map(sy => field(esc(s.systems[sy]), sel('projects.' + i + '.sizes.' + sy, s.sizes.map(z => [z.id, z.name + ' ×' + z.multiplier]), p.sizes[sy] ?? s.defaultSize))).join('') : '<p class="hint">Choose a lead or backup with skills first.</p>') + '</div>' +
        '<h3>Complexity</h3>' + many('projects.' + i + '.factors', s.factors.map(f => [f.id, f.name + ' ×' + f.multiplier]), p.factors) + '</div>';
    }).join(''));

  const unmapped = s.demo ? '' : panel('Needs mapping', 'Jira issues from the last refresh that Relay could not plan. Fix a task type rule, a component, or a project contact, then refresh.',
    meta.unmapped.length ? table(['Issue', 'Project', 'Reason'], meta.unmapped.map(u => '<tr><td><b>' + esc(u.key) + '</b> ' + esc(u.summary) + '</td><td>' + esc(u.project) + '</td><td>' + esc(u.reason) + '</td></tr>')) : '<p class="empty">Nothing to map.</p>');

  $('view').innerHTML = mode + unmapped + general + estimation + types + systems + people + projects;
}

/** Live estimate preview so admins can see what the numbers produce before saving. */
function tryIt() {
  return '<h3>Try an estimate</h3><div class="grid-form">' +
    field('Task type', '<select data-trial="type">' + opts(s.types.map((t, i) => [i, t.name]), trial.type) + '</select>') +
    field('Project', '<select data-trial="p">' + opts(s.projects.map((p, i) => [i, p.name]), trial.p) + '</select>') +
    field('System', '<select data-trial="s">' + opts(systemsList(), trial.s) + '</select>') +
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

const blank = {
  size: () => ({ id: 'S' + (s.sizes.length + 1), name: 'New size', multiplier: 1 }),
  factor: () => ({ id: 'f' + crypto.randomUUID().slice(0, 8), name: 'New factor', multiplier: 1.1, label: '' }),
  system: () => 'New system',
  type: () => ({ name: 'New task type', system: 0, baseHours: 8, bufferHours: 4, source: 'relay', hoursPerPoint: 4, issueTypes: '', components: '', labels: '', archived: false }),
  person: () => ({ name: 'New person', role: '', access: 'member', skills: [], accountId: null, pmProjects: [], archived: false }),
  project: () => ({ name: 'New project', jiraKey: '', jql: '', due: '', lead: null, back: null, sizes: {}, factors: [], archived: false })
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
  if (t.dataset.defaultSize) { s.defaultSize = t.dataset.defaultSize; markDirty(); }
  if (t.tagName === 'SELECT' && t.dataset.path && t.dataset.rerender === undefined) render(); // keep estimate preview current
});
document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.hasAttribute('data-dismiss')) $('modal').close();
  if (b.dataset.add) { s[listOf[b.dataset.add]].push(blank[b.dataset.add]()); markDirty(); render(); }
  if (b.id === 'switchMode') modal(s.demo ? 'Switch to live Jira data?' : 'Switch back to demo data?', '<p>' + (s.demo ? 'The demo team, projects and plan are removed. Your systems, task types, sizes and factors are kept. Then add your Jira users and connect Jira projects.' : 'The live plan and Relay-only records (timesheets, private time, blockers) are removed and replaced with the demo. Jira itself is not changed.') + '</p><div class="actions"><button data-dismiss>Cancel</button><button class="primary" id="confirmSwitch">Switch</button></div>');
  if (b.id === 'confirmSwitch') { $('modal').close(); await run(() => call('saveSettings', { switchMode: true }), 'Mode switched.'); if (!s.demo && meta.jira) { jiraProjects = (await call('jiraProjects')).projects; render(); } }
  if (b.id === 'refreshNow') {
    if (dirty) return status('Save settings before refreshing.', true);
    status('Reading Jira…');
    try { await call('refresh'); await load(); status('Refreshed from Jira. ' + meta.unmapped.length + ' issues need mapping.'); } catch (err) { status(err.message, true); }
  }
  if (b.id === 'save') await run(() => call('saveSettings', { settings: s }), 'Settings saved.');
  if (b.id === 'discard') { s = structuredClone(saved); dirty = false; render(); status('Changes discarded.'); }
  if (b.id === 'userSearch') {
    try { userResults = (await call('searchUsers', { query: $('userQuery').value })).users; render(); if (!userResults.length) status('No Jira users found.'); } catch (err) { status(err.message, true); }
  }
  if (b.id === 'userAdd') {
    const u = userResults[Number($('userPick').value)];
    if (u && !s.people.some(p => p.accountId === u.accountId)) { s.people.push({ ...blank.person(), name: u.name, accountId: u.accountId }); markDirty(); }
    userResults = []; render();
  }
  if (b.id === 'jiraAdd') {
    const j = jiraProjects.find(x => x.key === $('jiraPick').value);
    if (j) { s.projects.push({ ...blank.project(), name: j.name, jiraKey: j.key }); markDirty(); render(); }
  }
});
async function run(fn, message) {
  try { meta = await fn(); saved = meta.settings; s = structuredClone(saved); dirty = false; render(); status(message); }
  catch (err) { status(err.message, true); }
}
function modal(title, html) { $('dialogTitle').textContent = title; $('body').innerHTML = html; $('modal').showModal(); }
$('close').onclick = () => $('modal').close();
window.addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });

load();
