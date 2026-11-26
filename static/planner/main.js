// Relay planner UI (ported from team-planner.html). The backend owns the plan; this page previews and sends changes.
import { createModel } from '../../src/shared/model.js';
import { estimate, toSlots } from '../../src/shared/estimate.js';
import { call, openIssue, isLocal } from '../common/backend.js';
import { $, esc, options, modal } from '../common/ui.js';

const colors = [['#248275', '#d8eee8', '#184e46'], ['#7460a8', '#e9e3f5', '#493c69'], ['#ad7331', '#f5e9d4', '#6e4d24'], ['#4676a4', '#dfeaf5', '#304e70'], ['#aa626b', '#f6e4e5', '#6b3c44'], ['#68813f', '#e8efd9', '#455827']];

// Workspace (set by useWorkspace)
let settings, today, me, M, people, projects, systems, types, state, plan;
let fmt, span, slotLabel, hrs, daysLate, dueText, who, effectiveWork, duration, spent, statusOf, eligible, finish, off, take;
let spd, slotH, weekSlots, timeInJira = false;
// View state
let role = 'member', pmProject = 0, member = 2, reportWeek = 0;
try { const last = sessionStorage.getItem('relay.preview.role'); if (['member', 'team', 'pm'].includes(last)) role = last; const w = sessionStorage.getItem('relay.preview.member'); if (w !== null) member = Number(w); } catch {}
let week = 0, personFilter = 'all', tab = role === 'pm' ? 'outlook' : 'home', filter = 'all', showAll = false, draft = null, formValues = null, busy = false, booted = false;

function useWorkspace(ws) {
  settings = ws.settings; today = ws.today; me = ws.me; state = ws.state;
  M = createModel(settings, today);
  ({ people, projects, systems, types, fmt, span, slotLabel, hrs, daysLate, dueText, who, effectiveWork, duration, spent, statusOf, eligible, finish, off, take, spd, slotH, weekSlots } = M);
  if (!me.demo) { role = me.access; member = me.person; }
  if (role === 'pm' && !me.pmProjects.includes(pmProject)) pmProject = me.pmProjects[0] ?? 0;
  if (!people[member]) member = 0;
  plan = M.schedule(state);
  timeInJira = !!ws.timeInJira;
  if (!booted) { booted = true; week = reportWeek = Math.floor(M.now / weekSlots); tab = role === 'pm' ? 'outlook' : 'home'; }
}
const demoCtx = () => ({ role, member });
/** Monday–Sunday of the report week; the backend only sends timesheet entries for the period asked for. */
const weekRange = () => (M ? Object.fromEntries([['from', 0], ['to', 6]].map(([k, d]) => [k, new Date(M.cal.epoch + (reportWeek * 7 + d) * 86400000).toISOString().slice(0, 10)])) : undefined);
const startBlocker = t => M.startBlocker(state, plan, t);
const active = list => list.map((x, i) => [x, i]).filter(([x]) => !x.archived);

async function load(quiet = false) {
  try {
    const ws = await call('getWorkspace', { demo: demoCtx(), range: weekRange() });
    if (ws.notMember) return gate(ws.isAdmin);
    useWorkspace(ws);
    // The first request can't know the report week yet (it comes from the calendar), so fetch that week's entries once more.
    if (ws.range && ws.range.from !== weekRange().from) return load();
    render();
  } catch (e) { if (!quiet) fatal(e.message); }
}
// The backend refreshes from Jira every 5 minutes; pick that up without a manual reload, but never under an open dialog.
setInterval(() => { if (booted && document.visibilityState === 'visible' && !$('modal').open && !busy) load(true); }, 5 * 60 * 1000);
function gate(isAdmin) {
  document.querySelector('nav.tabs').hidden = document.querySelector('.hero').hidden = true;
  $('view').innerHTML = '<div class="gate"><h1>You are not on a Relay team yet</h1><p class="sub">' + (isAdmin ? 'Open Relay settings (Jira settings → Apps) to add yourself and your team.' : 'Ask a Jira administrator to add you in Relay settings.') + '</p></div>';
}
function fatal(msg) { $('view').innerHTML = '<div class="error-panel"><b>The plan could not be loaded.</b><br>' + esc(msg) + '</div>'; }

/** Send a change to the backend; it validates, applies and returns the new workspace. */
async function send(op, message = 'Change applied. The schedule and milestone forecasts are updated.') {
  if (busy) return;
  busy = true;
  try {
    const ws = await call('apply', { op, demo: demoCtx(), opId: crypto.randomUUID(), range: weekRange() });
    useWorkspace(ws);
    if ($('modal').open) $('modal').close();
    render();
    announce(message);
    return true;
  } catch (e) {
    if (e.code === 'stale') { await load(); }
    modal('Change could not be applied', '<p>' + esc(e.message) + '</p><div class="actions"><button data-dismiss>Close</button></div>');
  } finally { busy = false; }
}

function color(i) { const [a, b, c] = colors[i % colors.length]; return '--accent:' + a + ';--tint:' + b + ';--fg:' + c; }
function endWeek() {
  const w = s => Math.floor(s / weekSlots);
  return Math.max(w(M.now) + 3, ...state.tasks.map(t => w(t.ready)), ...[...plan.values()].filter(x => Number.isFinite(x.end)).map(x => w(x.end - 1)),
    ...[...state.leave, ...state.privateTime, ...state.fixed.map(f => ({ start: f.start, len: 1 })), ...state.tasks.flatMap(t => (t.history || []).map(h => ({ start: h.start, len: h.end - h.start })))].map(x => w(x.start + x.len - 1)));
}
function projectLink(i) { return '<button class="project" data-project="' + i + '"><i class="dot" style="' + color(i) + '"></i>' + esc(projects[i].name) + '</button>'; }
function outlookText(d, p) { return !Number.isFinite(d) ? 'Waiting' : d > p.due ? daysLate(d, p.due) + ' workdays late' : 'On track'; }
const pageInfo = {
  home: ['Overview', ''], sheet: ['Timesheet', 'Hours you have recorded against project tasks and internal work.'],
  report: ['Weekly report', ''],
  queue: ['Work queue', 'See what is underway, what can start next, and what needs a decision.'],
  schedule: ['Team calendar', 'Assignments, protected time, and buffers across the team.'],
  coverage: ['Project coverage', 'Primary contacts, backups, and the systems each person covers.'],
  outlook: ['Project outlook', 'Milestone forecasts, agreed starts, and notes shared with the team.'],
  rules: ['Planning rules', 'How the team uses this planner and how its forecasts are calculated.']
};

function render() {
  const pm = role === 'pm', personal = role === 'member';
  const pages = personal ? ['home', 'schedule', 'sheet', 'report', 'rules'] : pm ? ['outlook', 'report', 'rules'] : ['home', 'queue', 'schedule', 'coverage', 'report', 'rules'];
  if (!pages.includes(tab)) tab = pages[0];
  $('roleBox').hidden = !me.demo; $('role').value = role;
  $('memberPreview').hidden = !me.demo || !personal;
  $('memberPreview').innerHTML = options(active(people).map(([p, i]) => [i, p.name]), member);
  $('identity').hidden = me.demo; $('identity').textContent = me.demo ? '' : me.name + ' · ' + { member: 'Team member', team: 'Team manager', pm: 'Project manager' }[role];
  $('refresh').hidden = me.demo || role !== 'team';
  $('settingsLink').hidden = !isLocal;
  $('reset').hidden = !(me.demo && role === 'team');
  $('footnote').textContent = me.demo ? 'Demo portfolio · Fictional data · Switch to live mode in Relay settings' : 'Live plan · ' + (state.refreshedAt ? 'Jira refreshed ' + new Date(state.refreshedAt).toLocaleString('en-GB') : 'Not refreshed from Jira yet') + (state.unmapped.length && role === 'team' ? ' · ' + state.unmapped.length + ' Jira issues need mapping (see settings)' : '');
  $('simulate').hidden = !(role === 'team' && ['home', 'queue', 'schedule', 'coverage'].includes(tab) || personal && ['home', 'sheet', 'schedule'].includes(tab));
  $('simulate').textContent = personal ? (tab === 'schedule' ? 'Protect time' : '＋ Log time') : '＋ Test a change';
  const title = tab === 'home' ? (personal ? 'My work' : 'Team overview') : tab === 'sheet' ? 'My timesheet' : tab === 'schedule' && personal ? 'My calendar' : tab === 'report' ? (personal ? 'My weekly report' : pm ? 'Project report' : 'Team report') : pageInfo[tab][0];
  $('title').textContent = title;
  const counts = active(people).length + ' people across ' + active(projects).length + ' projects';
  $('intro').textContent = tab === 'home' ? (personal ? who(member).name + ' · ' + (who(member).role || 'Team member') : counts + '. Review available capacity and work that needs a decision.') : tab === 'report' ? (pm ? 'Project hours and delivery outlook.' : personal ? 'A weekly summary of your recorded work.' : 'Weekly hours by person and project.') : (personal && tab === 'schedule' ? 'Your assignments, protected time, and troubleshooting reserves.' : pageInfo[tab][1]);
  for (const k of Object.keys(pageInfo)) {
    const btn = $(k + 'Tab'); btn.hidden = !pages.includes(k);
    if (k === 'home') btn.textContent = personal ? 'My work' : 'Overview';
    btn.classList.toggle('active', k === tab); btn.setAttribute('aria-current', k === tab ? 'page' : 'false');
  }
  const views = { home: personal ? memberHome : managerHome, queue: queueView, schedule: () => board() + (role === 'team' ? milestones() : ''), coverage, outlook: pmView, sheet: timesheetView, report: reportView, rules: rulesView };
  $('view').innerHTML = views[tab]();
  // Phones show table rows as labelled blocks (CSS .stack); labels come from the header cells.
  for (const table of $('view').querySelectorAll('table.data:not(.load-table)')) {
    const heads = [...table.querySelectorAll('th')].map(th => th.textContent);
    table.classList.add('stack');
    for (const row of table.tBodies[0]?.rows ?? []) [...row.cells].forEach((td, i) => { td.dataset.label = heads[i] ?? ''; });
  }
}

function board() {
  const start = week * weekSlots, cols = weekSlots;
  const rows = people.map((p, w) => {
    if (p.archived || (role === 'member' && w !== member)) return '';
    const blocks = [];
    function add(a, b, html) {
      if (b <= start || a >= start + cols) return;
      const col = Math.max(a, start) - start + 1, len = Math.min(b, start + cols) - Math.max(a, start);
      blocks.push(html.replace('STYLE', 'grid-row:1;grid-column:' + col + '/span ' + len + ';'));
    }
    /** Add a block over the slots this person works in [a, b): split around days off. */
    function addWorking(a, b, html) {
      for (let s = a; s < b; s++) { if (off(w, s)) continue; let e = s + 1; while (e < b && !off(w, e)) e++; add(s, e, html); s = e; }
    }
    for (const t of state.tasks) {
      for (const h of t.history || []) if (h.who === w) add(h.start, h.end, '<button class="block done" data-task="' + t.id + '" style="STYLE' + color(t.p) + '"><b>' + esc(projects[t.p].name) + '</b><small>Worked · ' + esc(t.name) + '</small></button>');
      const x = plan.get(t.id);
      if (!Number.isFinite(x.start)) {
        const fixed = state.fixed.find(f => f.taskId === t.id);
        if (fixed && t.firstStart == null && x.who === w) add(fixed.start, fixed.start + duration(t), '<button class="block meeting fixed" data-task="' + t.id + '" style="STYLE' + color(t.p) + '"><b>' + esc(projects[t.p].name) + '</b><small>Fixed start · At risk</small></button>');
        continue;
      }
      if (x.who !== w) continue;
      const fixed = state.fixed.some(f => f.taskId === t.id), workEnd = Math.min(x.end, take(w, x.start, Math.max(1, effectiveWork(t) - spent(t))).at(-1) + 1);
      const label = t.actual != null ? 'Done · ' : t.started ? 'In progress · ' : fixed ? 'Fixed start · ' : '';
      const card = (css, title, subtitle) => '<button class="block ' + css + '" data-task="' + t.id + '" style="STYLE' + color(t.p) + '" title="' + esc(projects[t.p].name + ' · ' + t.name + ' · ' + subtitle) + '"><b>' + esc(title) + '</b><small>' + esc(subtitle) + '</small></button>';
      addWorking(x.start, workEnd, card((fixed ? 'meeting fixed ' : '') + (t.actual != null ? 'done' : ''), projects[t.p].name, label + t.name));
      if (workEnd < x.end) addWorking(workEnd, x.end, card('buffer', 'Buffer', projects[t.p].name + ' · ' + t.name));
    }
    for (const block of state.privateTime.filter(x => x.who === w)) add(block.start, block.start + block.len, '<button class="block private" data-private="' + block.id + '" style="STYLE"><b>Private time</b><small>' + esc(block.name) + '</small></button>');
    const away = new Set();
    for (const l of state.leave.filter(l => l.who === w)) for (let d = l.start; d < l.start + l.len; d++) away.add(d);
    for (let d = start; d < start + cols; d++) { if (!away.has(d)) continue; let e = d + 1; while (e < start + cols && away.has(e)) e++; add(d, e, '<div class="block away" style="STYLE"><b>Time off</b><small>Unavailable</small></div>'); d = e - 1; }
    for (let d = start; d < start + cols; d++) { if (!off(w, d)) continue; let e = d + 1; while (e < start + cols && off(w, e)) e++; add(d, e, '<div class="block away" style="STYLE"><b>' + (M.isHoliday(d) ? 'Holiday' : 'Not working') + '</b><small>' + (M.isHoliday(d) ? 'Public holiday' : 'Outside working hours') + '</small></div>'); d = e - 1; }
    return '<div class="person grid"><div class="who"><span class="avatar">' + esc(p.initials) + '</span><div><b>' + esc(p.name) + '</b><small>' + esc(p.role || '') + '</small></div></div><div class="lane" style="grid-template-columns:repeat(' + cols + ',minmax(0,1fr))">' + blocks.join('') + '</div></div>';
  }).join('');
  const nowWeek = Math.floor(M.now / weekSlots);
  return '<section class="panel"><div class="section-head"><div class="row"><h2>' + span(start, start + cols - 1) + '</h2><span class="tag">' + (week === nowWeek ? 'Planning week' : week < nowWeek ? 'Past week' : 'Forecast week') + '</span></div><div class="controls"><button class="arrow" id="prev" aria-label="Previous week" ' + (week === 0 ? 'disabled' : '') + '>‹</button><button id="first">This week</button><button class="arrow" id="next" aria-label="Next week" ' + (week >= endWeek() ? 'disabled' : '') + '>›</button></div></div><div class="scroll"><div class="board"><div class="grid days"><div>Team member</div>' + Array.from({ length: 5 }, (_, i) => '<div>' + fmt(start + i * spd, { weekday: 'short', day: 'numeric' }) + (M.isHoliday(start + i * spd) ? ' · Holiday' : '') + '</div>').join('') + '</div>' + rows + '</div></div><div class="foot"><span>Striped task buffers reserve time for troubleshooting · ' + slotH + 'h slots</span><span>Week ' + (week + 1) + ' of ' + (endWeek() + 1) + '</span></div></section>';
}

function milestones() {
  const indices = active(projects).map(([, i]) => i).filter(i => filter === 'all' || String(i) === filter), list = showAll ? indices : indices.slice(0, 5);
  return '<section class="panel"><div class="section-head"><div><h2>Project milestones</h2><p>Forecast completion of each project’s planned work.</p></div><select id="filter" aria-label="Filter milestones by project"><option value="all">All projects</option>' + active(projects).map(([p, i]) => '<option value="' + i + '" ' + (filter === String(i) ? 'selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select></div><div class="scroll"><table class="data"><thead><tr><th>Project</th><th>Primary</th><th>Requested by</th><th>Forecast</th><th>Outlook</th></tr></thead><tbody>' + list.map(i => { const d = finish(state, plan, i), p = projects[i]; return '<tr><td>' + projectLink(i) + '</td><td>' + esc(who(p.lead).short) + '</td><td>' + dueText(p) + '</td><td>' + fmt(d) + '</td><td class="' + (d > p.due ? 'late' : 'status') + '">' + outlookText(d, p) + '</td></tr>'; }).join('') + '</tbody></table></div>' + (indices.length > 5 ? '<div class="foot"><span>' + list.length + ' of ' + indices.length + ' projects</span><button class="link" id="more">' + (showAll ? 'Show fewer' : 'Show all projects') + '</button></div>' : '') + '</section>';
}
function coverage() {
  return '<section class="panel"><div class="section-head"><div><h2>Project contacts</h2><p>Select a project for system-level coverage and scheduled tasks.</p></div></div><div class="scroll"><table class="data"><thead><tr><th>Project</th><th>Primary</th><th>Backup</th><th>Systems</th></tr></thead><tbody>' + active(projects).map(([p, i]) => '<tr><td>' + projectLink(i) + '</td><td>' + esc(who(p.lead).name) + '</td><td>' + (p.back === null ? 'No backup' : esc(who(p.back).name)) + '</td><td>' + p.systems.length + '</td></tr>').join('') + '</tbody></table></div></section>';
}

function queueView() {
  const items = state.tasks.filter(t => personFilter === 'all' || String(plan.get(t.id).who) === personFilter).sort((a, b) => a.rank - b.rank);
  const running = items.filter(t => t.started && t.actual == null);
  const waiting = items.filter(t => t.wait);
  const ready = items.filter(t => !t.started && !t.wait && !startBlocker(t));
  const keyTag = t => (t.key ? ' · ' + esc(t.key) : '');
  function tile(t) {
    const x = plan.get(t.id), p = who(x.who);
    return '<button class="task-tile" data-task="' + t.id + '"><span class="tile-project"><i class="dot" style="' + color(t.p) + '"></i>' + esc(projects[t.p].name) + ' / ' + esc(systems[t.s]) + keyTag(t) + '</span><strong>' + esc(t.name) + '</strong><span class="tile-detail">' + (t.wait ? esc(t.wait.reason) : span(x.start, x.end - 1)) + '</span><span class="tile-owner"><i>' + esc(p.initials) + '</i>' + esc(p.name) + '</span>' + (assigneeNote(t, x) ? '<span class="tile-warn">⚠ ' + esc(assigneeNote(t, x)) + '</span>' : '') + '</button>';
  }
  function lane(label, cls, list, empty) {
    return '<section class="lane-panel ' + cls + '"><h2><i></i>' + label + ' <span>' + list.length + '</span></h2>' + list.slice(0, 2).map(tile).join('') + (list.length > 2 ? '<details><summary class="more-summary">Show ' + (list.length - 2) + ' more</summary>' + list.slice(2).map(tile).join('') + '</details>' : '') + (list.length ? '' : '<p class="lane-empty">' + empty + '</p>') + '</section>';
  }
  function row(t) {
    const x = plan.get(t.id);
    return '<tr><td><button class="link" data-task="' + t.id + '">' + esc(t.name) + '</button><small class="meta-line">' + esc(projects[t.p].name) + ' / ' + esc(systems[t.s]) + keyTag(t) + '</small></td><td>' + esc(who(x.who).name) + (assigneeNote(t, x) ? '<small class="meta-line">⚠ ' + esc(assigneeNote(t, x)) + '</small>' : '') + '</td><td>' + span(x.start, x.end - 1) + '</td><td>' + statusOf(t) + '</td></tr>';
  }
  const table = group => '<div class="scroll"><table class="data"><thead><tr><th>Task and system</th><th>Owner</th><th>Work window</th><th>State</th></tr></thead><tbody>' + group.map(row).join('') + '</tbody></table></div>';
  return '<div class="queue-tools"><label>Team member <select id="personFilter">' + options([['all', 'Everyone'], ...active(people).map(([p, i]) => [i, p.name])], personFilter) + '</select></label><button id="addQueued">＋ Add task</button></div><div class="swimlanes">' + lane('In progress', 'running', running, 'No active work for this selection.') + lane('Next to start', 'ready', ready, 'Upcoming work is waiting for capacity or a prerequisite.') + lane('Waiting', 'waiting', waiting, 'No external blockers recorded.') + '</div><section class="panel"><div class="section-head"><div><h2>Portfolio queue</h2><p>Tasks in priority order, including dependent work.</p></div><span class="sub">' + items.length + ' tasks</span></div>' + (items.length ? table(items.slice(0, 5)) : '<p class="empty">No tasks yet. ' + (me.demo ? '' : 'Use Refresh from Jira, or add a task.') + '</p>') + (items.length > 5 ? '<details><summary class="more-summary">Show remaining ' + (items.length - 5) + ' tasks</summary>' + table(items.slice(5)) + '</details>' : '') + '</section>';
}

function rulesView() {
  const g = settings.general;
  const rules = [
    ['Choose work', 'Members open My work for their current task and upcoming assignments. The team manager uses Work queue to see active, ready, and waiting work across projects. Open an assignment to start on its forecast slot.'],
    ['Hours and slots', 'Effort is entered in hours and planned in ' + g.slotHours + '-hour slots, ' + g.workdayHours / g.slotHours + ' per ' + g.workdayHours + '-hour workday. Estimates round up to a whole slot, so a person never carries more than ' + g.workdayHours / g.slotHours + ' tasks in a day.'],
    ['Days off', 'Public holidays and each person’s working days and hours come from Relay settings. Work is planned only in the slots someone works and pauses over days off.'],
    ['How estimates are made', 'Each task type has a base effort and buffer. Relay first looks for at least ' + g.minSamples + ' finished tasks of the same type in the last ' + g.historyMonths + ' months: same project and system, then same system, then any. The estimate is the P' + g.estimatePercentile + ' of their actual hours and the buffer runs to P' + g.bufferPercentile + '. Without history it uses the type default × system size × complexity factors such as data transfer or VPN access. Types can instead take Jira’s original estimate or story points.'],
    ['Work and buffer', 'Enter the clear-sky effort for hands-on work. Adjust its buffer for known uncertainty. Troubleshooting uses the reserve first. Record total hands-on hours at completion; this releases unused time and teaches the estimator.'],
    ['Waiting for someone else', 'From an active task choose Mark waiting. Record the work already performed and what will unblock it. The remaining work stops reserving capacity. Its dependent dates show Pending. Resolve the blocker to put the remaining work back in the queue.'],
    ['Forecasts and commitments', 'A forecast can move when work, priority, or availability changes. Set a fixed start only when a date has been agreed. Preview the effect of changes before applying them. A fixed start with an unresolved prerequisite is at risk.'],
    ['Private time and coverage', 'The team can reserve private work and record absences under Test a change. The planner uses qualified project contacts and gives the primary contact the tie. Project managers see the forecast, shared note, and agreed starts.'],
    ['Timesheets and reports', timeInJira ? 'Time is logged only in Jira: Log time adds a Jira work log on the issue' + (settings.general.internalIssue ? ', and internal work goes on ' + esc(settings.general.internalIssue) : '') + '. The timesheet and reports read those work logs back. Team managers see totals by person and project, project managers see their project, and Export CSV downloads the week.' : 'Members record actual time by day and task. Internal work has its own category. Members can correct their entries. Team managers see totals by person and project. Project managers see aggregate project hours. Entry notes are personal. Export CSV downloads the week.'],
    me.demo ? ['Using the demo', 'This is fictional data. Demo view lets you try the three roles. A Jira administrator can connect real Jira projects in Relay settings.'] : ['Jira', 'Tasks come from the connected Jira projects and are read-only in Jira. Jira workflow status stays in Jira; Relay’s start, waiting and finish actions are planning events. Refresh from Jira to pick up new issues.']
  ];
  return '<div class="rules-grid">' + rules.map(([title, body]) => '<article class="rule"><h2>' + title + '</h2><p>' + body + '</p></article>').join('') + '</div>';
}

function taskDetail(id) {
  if (role === 'pm' || (role === 'member' && plan.get(id)?.who !== member)) return;
  const t = state.tasks.find(t => t.id === id), x = plan.get(id), blocker = t.started ? '' : startBlocker(t);
  let actions = '';
  if (!t.started && !t.wait) actions = (role === 'team' ? '<button ' + (t.firstStart != null ? 'disabled' : '') + ' data-timing="' + id + '">' + (state.fixed.some(f => f.taskId === id) ? 'Edit fixed start' : 'Set a fixed start') + '</button>' : '') + '<button data-estimate="' + id + '">Edit estimate</button><button class="primary" data-start="' + id + '" ' + (blocker ? 'disabled' : '') + '>Start on ' + slotLabel(x.start) + '</button>';
  if (t.wait) actions = '<button class="primary" data-resume="' + id + '">Resolve blocker</button>';
  if (t.started && t.actual == null) actions = '<button data-pause="' + id + '">Mark waiting</button><button data-revise="' + id + '">Update expected duration</button><button class="primary" data-finish="' + id + '">Record finish</button>';
  if (role === 'member' && (!timeInJira || t.key)) actions += '<button data-log-task="' + id + '">Log time</button>';
  if (role === 'team' && !me.demo && t.key && Number.isFinite(x.end)) actions += '<button data-push="assignee" data-push-task="' + id + '">Set Jira assignee to ' + esc(who(x.who).short) + '</button><button data-push="duedate" data-push-task="' + id + '">Set Jira due date to ' + fmt(x.end - 1) + '</button>';
  if (t.key) actions = '<button data-issue="' + esc(t.key) + '">Open ' + esc(t.key) + ' in Jira</button>' + actions;
  modal(projects[t.p].name + ' · ' + t.name, '<p class="note"><b>' + esc(who(x.who).name) + '</b> · ' + esc(systems[t.s]) + ' · ' + span(x.start, x.end - 1) + '<br>' + statusOf(t) + (t.gone ? ' · No longer in the Jira filter' : '') + '</p>' + (t.wait ? '<p class="wait-note"><b>Waiting for</b> ' + esc(t.wait.reason) + '</p>' : '') + '<p>Task type: ' + esc(types[t.type]?.name ?? '—') + '<br>Clear-sky effort: ' + hrs(t.work) + '<br>Original buffer: ' + hrs(t.buffer) + '<br>' + (t.actual != null ? 'Actual effort: ' + hrs(t.actual) : 'Current expected work: ' + hrs(effectiveWork(t)) + '<br>Buffer remaining: ' + hrs(duration(t) - effectiveWork(t))) + '</p><p class="source">Estimate: ' + esc(t.source || '—') + '</p><p>Qualified contacts: ' + (eligible(t).map(w => esc(people[w].name)).join(', ') || 'None') + '<br>Depends on: ' + esc((t.deps ?? []).map(d => state.tasks.find(z => z.id === d)?.name).filter(Boolean).join(', ') || 'Ready to start') + (t.assignee ? '<br>Jira assignee: ' + esc(t.assignee.name) + (assigneeNote(t, x) ? ' ⚠ differs from the plan' : '') : '') + '</p><div class="task-actions">' + (role === 'team' ? '<button data-project="' + t.p + '">View project</button>' : '') + actions + '</div>' + (blocker ? '<p class="sub">' + esc(blocker) + '</p>' : ''));
}
function projectDetail(i) {
  if (role !== 'team') return;
  const p = projects[i];
  modal(p.name, '<p class="note">Requested by <b>' + dueText(p) + '</b> · Forecast <b>' + fmt(finish(state, plan, i)) + '</b>' + (p.jiraKey ? ' · Jira ' + esc(p.jiraKey) : '') + '</p>' + noteView(i) + '<h3>System coverage</h3>' + p.systems.map(s => '<div class="detail">' + esc(systems[s]) + ' · ' + eligible({ p: i, s }).map(w => esc(people[w].name)).join(', ') + '</div>').join('') + '<h3>Scheduled tasks</h3>' + state.tasks.filter(t => t.p === i).map(t => { const x = plan.get(t.id); return '<div class="detail"><button class="link" data-task="' + t.id + '">' + esc(t.name) + '</button><small>' + esc(who(x.who).name) + ' · ' + span(x.start, x.end - 1) + '</small></div>'; }).join(''));
}
function selectField(label, key, items, value, wide = false) { return '<label class="field ' + (wide ? 'full' : '') + '">' + label + '<select name="' + key + '" id="field-' + key + '">' + options(items, value) + '</select></label>'; }
function values() { return Object.fromEntries(new FormData($('changeForm'))); }
const hourInput = (label, key, hours, min) => '<label class="field">' + label + '<input type="number" required min="' + min + '" step="' + slotH + '" max="8760" name="' + key + '" value="' + Number(hours) + '"></label>';

function changeForm(v = {}) {
  const kind = v.kind || 'urgent', p = Number(v.p ?? active(projects)[0]?.[1] ?? 0);
  const dates = Array.from({ length: (endWeek() + 2) * weekSlots }, (_, i) => i).filter(i => i >= M.now).map(i => [i, slotLabel(i)]);
  const dayDates = dates.filter(([i]) => i % spd === 0).map(([i]) => [i, fmt(i, { weekday: 'short', month: 'short', day: 'numeric' })]);
  const hourChoices = Array.from({ length: 20 }, (_, i) => [(i + 1) * slotH, (i + 1) * slotH + 'h']);
  const dayChoices = Array.from({ length: 10 }, (_, i) => [i + 1, (i + 1) + ' workday' + (i ? 's' : '')]);
  const footer = '<div class="actions"><button type="button" data-dismiss>Cancel</button><button class="primary" type="submit">Preview impact →</button></div>';
  if (['estimate', 'finish', 'revise'].includes(kind)) {
    const t = state.tasks.find(t => t.id === v.taskId);
    const fields = kind === 'estimate' ? hourInput('Clear-sky hours', 'hours', v.hours ?? t.work * slotH, slotH) + hourInput('Buffer hours', 'buffer', v.buffer ?? t.buffer * slotH, 0) : hourInput(kind === 'finish' ? 'Actual hours from start' : 'Expected total hours from start', 'hours', v.hours ?? effectiveWork(t) * slotH, slotH);
    modal(kind === 'estimate' ? 'Edit estimate' : kind === 'finish' ? 'Record finish' : 'Update expected duration', '<p>' + esc(projects[t.p].name) + ' · ' + esc(t.name) + '</p><form id="changeForm"><input type="hidden" name="kind" value="' + kind + '"><input type="hidden" name="taskId" value="' + t.id + '"><div class="formgrid">' + fields + '</div><p class="sub">' + (kind === 'finish' ? 'Recording completion releases any unused reserve and adds this task to the estimation history.' : 'Hours round up to ' + slotH + 'h slots. The forecast includes the work and any remaining reserve.') + '</p>' + footer + '</form>');
    return;
  }
  if (kind === 'pause' || kind === 'resume') {
    const t = state.tasks.find(t => t.id === v.taskId), x = plan.get(t.id);
    const field = kind === 'pause' ? '<label class="field">What will unblock this task?<input name="reason" required maxlength="200" value="' + esc(v.reason || '') + '"></label><label class="field">Hours spent since this start<input type="number" min="0" step="' + slotH + '" max="' + (x.end - x.start) * slotH + '" required name="used" value="' + Number(v.used ?? 0) + '"></label><label class="full"><input name="shareReason" type="checkbox" ' + (v.shareReason ? 'checked' : '') + '> Share this blocker with the project manager</label>'
      : selectField('Available to resume from', 'resumeDay', dates.filter(([d]) => d >= t.ready), v.resumeDay ?? Math.max(t.ready, M.now));
    modal(kind === 'pause' ? 'Mark waiting' : 'Resolve blocker', '<p>' + esc(t.name) + '</p><form id="changeForm"><input type="hidden" name="kind" value="' + kind + '"><input type="hidden" name="taskId" value="' + t.id + '"><div class="formgrid">' + field + '</div>' + footer + '</form>');
    return;
  }
  if (kind === 'timing') {
    const task = state.tasks.find(t => t.id === v.taskId), fixed = state.fixed.find(f => f.taskId === task.id);
    const stamp = v.stamp ?? (fixed ? M.cal.isoOfDay(Math.floor(fixed.start / spd)) : '');
    modal('Task timing', '<p><b>' + esc(projects[task.p].name) + ' · ' + esc(task.name) + '</b><br>Currently planned for ' + slotLabel(plan.get(task.id).start) + '.</p><form id="changeForm"><input type="hidden" name="kind" value="timing"><input type="hidden" name="taskId" value="' + task.id + '"><label class="field">Fixed start date (optional)<input type="date" name="stamp" min="' + settings.general.planStart + '" value="' + esc(stamp) + '"></label><p class="sub">Use an agreed date to anchor the start and share this task and date with the PM. Leave blank for flexible scheduling.</p>' + footer + '</form>');
    return;
  }
  let fields = role === 'member' && kind === 'private' ? '<input type="hidden" name="kind" value="private"><input type="hidden" name="who" value="' + member + '">' : selectField('Change to test', 'kind', [['queued', 'Add a task to the queue'], ['urgent', 'Add an urgent task'], ['leave', 'Mark a person away'], ...(state.tasks.some(t => t.actual == null) ? [['extend', 'Extend an existing task']] : []), ['private', 'Protect private team time']], kind, true);
  if (kind === 'urgent' || kind === 'queued') {
    const typeList = active(types), type = Number(v.type ?? typeList[typeList.length - 1]?.[1] ?? 0);
    const sys = projects[p]?.systems ?? [], s = sys.includes(Number(v.s)) ? Number(v.s) : sys.includes(types[type]?.system) ? types[type].system : sys[0];
    const est = s == null ? null : estimate(settings, { type, p, s }, state.completed, today);
    const estHours = est ? Math.max(1, toSlots(est.hours, slotH)) * slotH : slotH, estBuffer = est ? toSlots(est.buffer, slotH) * slotH : 0;
    fields += selectField('Task type', 'type', typeList.map(([a, i]) => [i, a.name]), type, true);
    fields += '<label class="field full">Task name<input required maxlength="70" name="name" value="' + esc(v.name ?? (kind === 'urgent' ? 'Urgent ' + types[type].name.toLowerCase() : types[type].name)) + '"></label>' + selectField('Project', 'p', active(projects).map(([x, i]) => [i, x.name]), p) + selectField('System', 's', sys.map(x => [x, systems[x]]), s) + selectField('Earliest start', 'start', dates, v.start ?? Math.max(week * weekSlots, M.now)) + hourInput('Clear-sky hours', 'hours', v.keepHours ? v.hours : estHours, slotH) + hourInput('Buffer hours', 'buffer', v.keepHours ? v.buffer : estBuffer, 0) + '<input type="hidden" name="source" value="' + esc(est?.source ?? '') + '"><input type="hidden" name="estHours" value="' + estHours + '"><p class="source full">' + (est ? 'Suggested: ' + estHours + 'h + ' + estBuffer + 'h buffer · ' + esc(est.source) : 'Nobody on this project covers a system yet.') + '</p>';
  }
  if (kind === 'private') {
    const block = state.privateTime.find(b => b.id === v.blockId);
    fields += (block ? '<input type="hidden" name="blockId" value="' + esc(block.id) + '">' : '') +
      '<label class="field full">Private work label<input name="name" maxlength="70" required value="' + esc(v.name ?? 'Focus time') + '"></label>' +
      (role === 'member' ? '' : selectField('Team member', 'who', active(people).map(([x, i]) => [i, x.name]), v.who ?? 0, true)) +
      selectField('First protected slot', 'start', dates, v.start ?? Math.max(week * weekSlots, M.now)) + selectField('Duration', 'hours', hourChoices, v.hours ?? (v.len ? v.len * slotH : settings.general.workdayHours));
  }
  if (kind === 'leave') fields += selectField('Team member', 'who', active(people).map(([x, i]) => [i, x.name]), v.who ?? 0, true) + selectField('First day away', 'start', dayDates, v.start ?? Math.max(week * weekSlots, M.now)) + selectField('Time away', 'days', dayChoices, v.days ?? 2);
  if (kind === 'extend') fields += selectField('Task', 'taskId', state.tasks.filter(t => t.actual == null).map(t => [t.id, projects[t.p].name + ' · ' + t.name]), v.taskId, true) + selectField('Additional expected hours', 'hours', hourChoices, v.hours ?? slotH, true);
  modal('Test a change', '<p>Preview the effect on the published schedule. You decide whether to apply it.</p><form id="changeForm"><div class="formgrid">' + fields + '</div>' + footer + '</form>');
}

function preview(v) {
  if ((v.kind === 'urgent' || v.kind === 'queued') && Number(v.hours) !== Number(v.estHours)) v.source = 'Entered in Relay';
  formValues = v; draft = M.makeDraft(state, plan, v);
  const { next, slots, moved, summary } = draft;
  const changed = projects.map((p, i) => ({ p, i, old: finish(state, plan, i), now: finish(next, slots, i) })).filter(x => x.old !== x.now);
  if (role === 'member') {
    const own = moved.filter(t => plan.get(t.id).who === member || slots.get(t.id).who === member);
    modal('Change preview', '<p>' + esc(summary) + '</p><div class="note">' + own.length + ' of your assignments change.</div>' + own.map(t => '<div class="detail">' + esc(projects[t.p].name) + ' · ' + esc(t.name) + '<small>' + span(plan.get(t.id).start, plan.get(t.id).end - 1) + ' → ' + span(slots.get(t.id).start, slots.get(t.id).end - 1) + '</small></div>').join('') + '<div class="actions"><button data-dismiss>Discard</button><button class="primary" id="apply">Apply change</button></div>');
    return;
  }
  const newTask = next.tasks.length > state.tasks.length ? next.tasks[next.tasks.length - 1] : null;
  const desc = x => who(x.who).short + ' · ' + span(x.start, x.end - 1);
  const newRow = newTask ? '<div class="detail"><b>New assignment</b>' + esc(desc(slots.get(newTask.id))) + '</div>' : '';
  modal('Change preview', '<p>' + esc(summary) + '</p><div class="note"><b>' + moved.length + ' existing assignment' + (moved.length === 1 ? '' : 's') + ' changed · ' + changed.length + ' milestone' + (changed.length === 1 ? '' : 's') + ' moved</b></div>' + newRow + '<h3>Milestone impact</h3>' + (changed.map(x => '<div class="detail"><b>' + esc(x.p.name) + ' · ' + fmt(x.old) + ' → ' + fmt(x.now) + '</b><small>Requested by ' + dueText(x.p) + ' · ' + outlookText(x.now, x.p) + '</small></div>').join('') || '<p>All project forecasts hold.</p>') + (moved.length ? '<details><summary>Inspect ' + moved.length + ' changed assignment' + (moved.length === 1 ? '' : 's') + '</summary>' + moved.map(t => '<div class="detail"><b>' + esc(projects[t.p].name) + ' · ' + esc(t.name) + '</b><small>' + esc(desc(plan.get(t.id))) + ' → ' + esc(desc(slots.get(t.id))) + '</small></div>').join('') + '</details>' : '') + '<div class="actions"><button id="editChange">Edit change</button><button data-dismiss>Discard</button><button class="primary" id="apply">Apply change</button></div>');
}
async function pushToJira(taskId, field) {
  if (busy) return;
  busy = true;
  try { useWorkspace(await call('pushToJira', { taskId, field, range: weekRange() })); $('modal').close(); render(); announce(field === 'assignee' ? 'Jira assignee updated.' : 'Jira due date updated.'); }
  catch (e) { modal('Jira was not updated', '<p>' + esc(e.message) + '</p><div class="actions"><button data-dismiss>Close</button></div>'); }
  finally { busy = false; }
}
function announce(text) { $('notice').textContent = text || ''; }

$('modal').addEventListener('close', () => { draft = null; formValues = null; });
$('close').onclick = () => $('modal').close();
$('simulate').onclick = () => (role === 'member' ? (tab === 'schedule' ? changeForm({ kind: 'private', who: member }) : logForm()) : changeForm());
$('reset').onclick = () => modal('Reset sample plan?', '<p>This restores the original assignments and time off and removes the changes you applied to the demo.</p><div class="actions"><button data-dismiss>Cancel</button><button id="confirmReset" class="primary">Reset demo</button></div>');
$('settingsLink').onclick = () => { location.href = '../settings/'; };
$('refresh').onclick = async () => {
  $('refresh').disabled = true; announce('Reading Jira…');
  try { useWorkspace(await call('refresh', { range: weekRange() })); render(); announce('Refreshed from Jira.' + (state.unmapped.length ? ' ' + state.unmapped.length + ' issues need mapping in Relay settings.' : '')); }
  catch (e) { announce(''); modal('Jira refresh failed', '<p>' + esc(e.message) + '</p><div class="actions"><button data-dismiss>Close</button></div>'); }
  finally { $('refresh').disabled = false; }
};
for (const k of Object.keys(pageInfo)) $(k + 'Tab').onclick = () => { tab = k; announce(''); render(); };
document.addEventListener('change', e => {
  const id = e.target.id;
  if (id === 'filter') { filter = e.target.value; render(); }
  if (id === 'field-kind') changeForm({ kind: e.target.value });
  // Type, project or system changes recompute the suggested estimate.
  if (id === 'field-type') { const v = values(); delete v.name; changeForm(v); }
  if (id === 'field-p') { const v = values(); delete v.s; changeForm(v); }
  if (id === 'field-s') changeForm(values());
  if (id === 'personFilter') { personFilter = e.target.value; render(); }
  if (id === 'pmProject') { pmProject = Number(e.target.value); announce(''); render(); }
});
document.addEventListener('submit', e => {
  if (e.target.id !== 'changeForm') return;
  e.preventDefault();
  try { preview(values()); } catch (err) {
    let msg = $('formError');
    if (!msg) { msg = document.createElement('p'); msg.id = 'formError'; msg.className = 'late'; msg.setAttribute('role', 'alert'); e.target.prepend(msg); }
    msg.textContent = err.message;
  }
});
document.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.hasAttribute('data-dismiss')) $('modal').close();
  if (b.dataset.task) taskDetail(b.dataset.task);
  if (b.dataset.issue) openIssue(b.dataset.issue);
  if (b.dataset.project !== undefined) projectDetail(+b.dataset.project);
  if (b.id === 'editChange') changeForm({ ...formValues, keepHours: true });
  if (b.id === 'prev' || b.id === 'next' || b.id === 'first') { week = b.id === 'first' ? Math.floor(M.now / weekSlots) : Math.max(0, Math.min(endWeek(), week + (b.id === 'next' ? 1 : -1))); render(); }
  if (b.id === 'more') { showAll = !showAll; render(); }
  if (b.id === 'apply' && draft) send({ kind: 'draft', v: formValues, baseRev: state.rev });
  if (b.id === 'confirmReset') { tab = 'home'; personFilter = 'all'; filter = 'all'; showAll = false; booted = false; send({ kind: 'reset' }, 'Sample plan restored.'); }
});

function noteView(i) {
  const note = state.notes[i] || '';
  return '<h3>Shared project note</h3>' + (note ? '<p class="context-note">' + esc(note) + '</p>' : '') + '<button data-note="' + i + '">' + (note ? 'Edit note' : 'Add a note') + '</button>';
}
function pmView() {
  const p = projects[pmProject];
  if (!p) return '<p class="empty">No projects are assigned to you yet. Ask a Jira administrator to add them in Relay settings.</p>';
  const forecast = finish(state, plan, pmProject);
  const fixed = state.fixed.map(f => ({ f, t: state.tasks.find(t => t.id === f.taskId) })).filter(x => x.t?.p === pmProject);
  const blockers = state.tasks.filter(t => t.p === pmProject && t.wait?.shared).map(t => '<p class="wait-note">' + esc(t.wait.reason) + '</p>').join('');
  const dates = fixed.length ? fixed.map(({ f, t }) => '<div class="detail">' + esc(t.name) + ' · <b>' + fmt(f.start) + '</b>' + (!Number.isFinite(plan.get(t.id).end) ? ' · At risk' : '') + '</div>').join('') : '<p class="sub">No fixed starts recorded.</p>';
  const risk = !Number.isFinite(forecast) ? 'Awaiting input' : forecast > p.due ? 'Forecast runs late' : 'On track';
  const tasks = state.tasks.filter(t => t.p === pmProject);
  const logged = logsThisWeek(reportWeek).filter(e => e.p === pmProject);
  const header = '<div class="queue-tools"><label>Project <select id="pmProject">' + options(me.pmProjects.filter(i => projects[i] && !projects[i].archived).map(i => [i, projects[i].name]), pmProject) + '</select></label><span class="sub">Contact · ' + esc(who(p.lead).name) + '</span></div>';
  const outlook = '<section class="focus-card"><div class="focus-label">' + risk + '</div><div class="focus-content"><small>' + esc(p.name) + ' milestone</small><h2>' + fmt(forecast) + '</h2><p>Requested by ' + dueText(p) + (Number.isFinite(forecast) && forecast > p.due ? ' · ' + daysLate(forecast, p.due) + ' workdays beyond target' : '') + '</p></div></section>';
  const effort = '<section class="panel summary-card"><div class="section-head"><h2>Project time</h2><small>Week of ' + fmt(reportWeek * weekSlots) + '</small></div><div class="time-large">' + hours(sumTime(logged)) + '</div><div class="sub">Recorded on ' + esc(p.name) + '</div><button class="link" data-page="report">Open project report →</button></section>';
  return header + '<div class="dash-pair">' + outlook + effort + '</div><section class="panel"><div class="section-head"><h2>Delivery details</h2><span class="sub">' + tasks.filter(t => t.actual != null).length + ' of ' + tasks.length + ' tasks completed</span></div><div class="content"><h3>Fixed starts</h3>' + dates + (blockers ? '<h3>Help needed</h3>' + blockers : '') + noteView(pmProject) + '</div></section>';
}
$('role').onchange = () => {
  role = $('role').value; tab = role === 'pm' ? 'outlook' : 'home';
  try { sessionStorage.setItem('relay.preview.role', role); } catch {}
  announce(''); $('body').replaceChildren(); render();
};
document.addEventListener('submit', event => {
  if (event.target.id !== 'noteForm') return;
  event.preventDefault();
  send({ kind: 'note', p: Number(event.target.dataset.projectIndex), text: $('sharedNote').value }, 'Shared project note saved.');
});
document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.hasAttribute('data-note')) {
    const i = Number(button.dataset.note);
    modal(projects[i].name + ' · Shared project note', '<form id="noteForm" data-project-index="' + i + '"><label class="field">Visible to the team and PM<textarea rows="4" id="sharedNote" maxlength="800">' + esc(state.notes[i] || '') + '</textarea></label><p class="sub">This is context for planning. Saving it leaves the schedule as it is.</p><div class="actions"><button data-dismiss type="button">Cancel</button><button class="primary">Save note</button></div></form>');
  }
  if (role === 'pm') return;
  if (button.id === 'addQueued') changeForm({ kind: 'queued' });
  for (const op of ['estimate', 'finish', 'revise', 'pause', 'resume']) if (button.dataset[op]) changeForm({ kind: op, taskId: button.dataset[op] });
  if (button.dataset.start) send({ kind: 'start', taskId: button.dataset.start });
  if (button.dataset.timing && role === 'team') changeForm({ kind: 'timing', taskId: button.dataset.timing });
  const id = button.dataset.private || button.dataset.editPrivate || button.dataset.releasePrivate;
  if (!id) return;
  const b = state.privateTime.find(block => block.id === id);
  const mine = role === 'team' || b.who === member;
  if (button.dataset.private) modal('Private team time', '<p class="note"><b>' + esc(b.name) + '</b><br>' + esc(who(b.who).name) + ' · ' + span(b.start, b.start + b.len - 1) + '</p><p>This time belongs to the team. The PM sees project forecasts and customer coordination only.</p>' + (mine ? '<div class="actions"><button data-release-private="' + id + '">Release time</button><button class="primary" data-edit-private="' + id + '">Edit private block</button></div>' : ''));
  if (button.dataset.editPrivate) changeForm({ ...b, kind: 'private', blockId: id });
  if (button.dataset.releasePrivate) send({ kind: 'releasePrivate', id });
});

function hours(minutes) { const whole = Math.floor(minutes / 60), part = minutes % 60; return part ? (whole ? whole + 'h ' : '') + part + 'm' : whole + 'h'; }
function logWeek(iso) { return Math.floor((Date.parse(iso + 'T00:00:00Z') - M.cal.epoch) / (86400000 * 7)); }
function weekdayName(iso) { return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
function logsThisWeek(w) { return state.logs.filter(e => logWeek(e.date) === w); }
function sumTime(entries) { return entries.reduce((n, e) => n + e.minutes, 0); }
function weekPicker(w) { return '<div class="period"><button data-period="-1" aria-label="Previous report week">‹</button><b>Week of ' + fmt(w * weekSlots) + '</b><button data-period="1" aria-label="Next report week">›</button></div>'; }
function tableBox(title, headers, rows, empty) {
  return '<section class="panel"><div class="section-head"><h2>' + title + '</h2></div>' + (rows.length ? '<div class="scroll"><table class="data"><thead><tr>' + headers.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(v => '<td>' + v + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' : '<p class="empty">' + empty + '</p>') + '</section>';
}
function metrics(items) { return '<div class="metrics">' + items.map(([label, value]) => '<div><small>' + label + '</small><strong>' + value + '</strong></div>').join('') + '</div>'; }
function projectTotals(entries) {
  const sums = new Map();
  for (const e of entries) sums.set(e.p, (sums.get(e.p) || 0) + e.minutes);
  return [...sums].sort((a, b) => b[1] - a[1]).map(([p, n]) => [p == null ? 'Internal work' : esc(projects[p]?.name ?? 'Archived project'), hours(n)]);
}
function memberHome() {
  const mine = state.tasks.filter(t => plan.get(t.id).who === member).sort((a, b) => a.rank - b.rank);
  const open = mine.filter(t => t.actual == null);
  const focus = open.find(t => t.started) || open.find(t => !startBlocker(t)) || open.find(t => t.wait);
  const entries = logsThisWeek(reportWeek).filter(e => e.who === member);
  let focusCard = '<p class="empty">No active or ready assignment. Review your upcoming work below.</p>';
  if (focus) {
    const x = plan.get(focus.id);
    focusCard = '<div class="focus-content"><small>' + esc(projects[focus.p].name) + ' / ' + esc(systems[focus.s]) + '</small><h2>' + esc(focus.name) + '</h2><p>' + (focus.wait ? esc(focus.wait.reason) : span(x.start, x.end - 1) + ' · ' + hrs(effectiveWork(focus)) + ' expected work · ' + hrs(duration(focus) - effectiveWork(focus)) + ' buffer') + '</p><button data-task="' + focus.id + '">Open task →</button></div>';
  }
  const rows = open.filter(t => t !== focus).map(t => [esc(projects[t.p].name), '<button class="link" data-task="' + t.id + '">' + esc(t.name) + '</button><small class="meta-line">' + esc(systems[t.s]) + '</small>', span(plan.get(t.id).start, plan.get(t.id).end - 1), statusOf(t)]);
  return '<div class="dash-pair"><section class="focus-card"><div class="focus-label">' + (focus?.started ? 'In progress' : focus?.wait ? 'Waiting' : 'Next assignment') + '</div>' + focusCard + '</section><section class="panel summary-card"><div class="section-head"><h2>My timesheet</h2><small>Week of ' + fmt(reportWeek * weekSlots) + '</small></div><div class="time-large">' + hours(sumTime(entries)) + '</div><div class="sub">Recorded this week</div><button class="link" data-page="sheet">Open timesheet →</button></section></div>' + tableBox('My other assignments', ['Project', 'Task and system', 'Forecast', 'State'], rows, 'Your queue is clear.');
}
/** One entry per slot of the week: work, buffer, protected, away or free. */
function loadSlots(w, person) {
  const start = w * weekSlots, end = start + weekSlots, slots = Array(weekSlots).fill('free');
  function put(a, b, k) { for (let i = Math.max(start, a); i < Math.min(b, end); i++) slots[i - start] = k; }
  for (const l of state.leave.filter(l => l.who === person)) put(l.start, l.start + l.len, 'away');
  for (const b of state.privateTime.filter(b => b.who === person)) put(b.start, b.start + b.len, 'protected');
  for (const t of state.tasks) {
    for (const h of t.history || []) if (h.who === person) put(h.start, h.end, 'work');
    const x = plan.get(t.id); if (x.who !== person) continue;
    if (Number.isFinite(x.start)) {
      const until = x.start + Math.max(1, effectiveWork(t) - spent(t));
      put(x.start, until, 'work'); put(until, x.end, 'buffer');
    } else {
      const f = state.fixed.find(f => f.taskId === t.id);
      if (f && t.firstStart == null) put(f.start, f.start + duration(t), 'work');
    }
  }
  return slots.map((k, i) => (off(person, start + i) ? 'off' : k));
}
/** Text when Jira says someone else is assigned than the person Relay plans; '' when they agree or nobody is assigned. */
function assigneeNote(t, x) {
  if (!t.assignee || !Number.isFinite(x?.start)) return '';
  const p = people[x.who];
  return p && (t.assignee.id ? t.assignee.id === p.accountId : t.assignee.name === p.name) ? '' : 'Jira assignee: ' + t.assignee.name;
}
function managerHome() {
  const differs = state.tasks.map(t => [t, plan.get(t.id)]).filter(([t, x]) => t.actual == null && assigneeNote(t, x));
  const team = active(people), loads = team.map(([, i]) => loadSlots(reportWeek, i));
  const waiting = state.tasks.filter(t => t.wait), late = projects.filter((p, i) => !p.archived && Number.isFinite(finish(state, plan, i)) && finish(state, plan, i) > p.due);
  const legend = { work: 'Project work', buffer: 'Buffer', protected: 'Private', away: 'Away', free: 'Open', off: 'Not working' };
  const cell = day => day.every(k => k === day[0]) ? '<span class="load-cell ' + day[0] + '">' + legend[day[0]] + '</span>' : '<span class="load-split">' + day.map(k => '<span class="load-cell ' + k + '" title="' + legend[k] + '">' + legend[k] + '</span>').join('') + '</span>';
  const capacity = '<section class="panel"><div class="section-head"><div><h2>Team capacity</h2><p>One cell per person per workday, split into ' + slotH + 'h slots when they differ.</p></div>' + weekPicker(reportWeek) + '</div><div class="scroll"><table class="data load-table"><thead><tr><th>Team member</th>' + Array.from({ length: 5 }, (_, i) => '<th>' + fmt(reportWeek * weekSlots + i * spd, { weekday: 'short', day: 'numeric' }) + '</th>').join('') + '</tr></thead><tbody>' + loads.map((slots, r) => '<tr><td>' + esc(team[r][0].name) + '</td>' + Array.from({ length: 5 }, (_, d) => '<td>' + cell(slots.slice(d * spd, d * spd + spd)) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div></section>';
  return metrics([['Open capacity this week', loads.flat().filter(k => k === 'free').length * slotH + 'h'], ['Tasks waiting now', waiting.length], ['Late milestone forecasts', late.length]]) + capacity + tableBox('Blockers to review', ['Project', 'Task', 'Owner', 'Waiting for'], waiting.map(t => [esc(projects[t.p].name), '<button class="link" data-task="' + t.id + '">' + esc(t.name) + '</button>', esc(who(t.wait.who).name), esc(t.wait.reason)]), 'No waiting tasks.') + (differs.length ? tableBox('Jira assignee differs from the plan', ['Task', 'Planned for', 'Jira assignee'], differs.map(([t, x]) => ['<button class="link" data-task="' + t.id + '">' + esc((t.key ? t.key + ' ' : '') + t.name) + '</button>', esc(who(x.who).name), esc(t.assignee.name)]), '') : '') + milestones() +
    tableBox('Recent changes', ['When', 'Who', 'What'], (state.changes ?? []).slice(0, 8).map(c => [new Date(c.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), esc(c.by), esc(c.what)]), 'No changes yet.');
}
/** Timesheet entries this role sees for the report week. */
function visibleEntries() {
  return logsThisWeek(reportWeek).filter(e => (role === 'member' ? e.who === member : role === 'pm' ? e.p === pmProject : true));
}
const exportButton = () => '<button data-export>Export CSV</button>';
/** Download the visible entries as CSV for invoicing or payroll. */
function exportCsv() {
  // A leading = + - @ would make spreadsheets run the cell as a formula.
  const cell = v => '"' + String(v ?? '').replace(/^[=+\-@]/, "'$&").replace(/"/g, '""') + '"';
  const rows = [['Date', 'Person', 'Project', 'Work', 'Hours', 'Comment'], ...visibleEntries().sort((a, b) => a.date.localeCompare(b.date)).map(e => {
    const t = state.tasks.find(t => t.id === e.task);
    return [e.date, people[e.who]?.name ?? '', e.p != null ? projects[e.p]?.name ?? '' : 'Internal work', t ? t.name : e.label ?? '', (e.minutes / 60).toFixed(2), e.note ?? ''];
  })];
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' })), download: 'timesheet-' + weekRange().from + '.csv' });
  a.click();
  URL.revokeObjectURL(a.href);
}
function timesheetView() {
  const entries = logsThisWeek(reportWeek).filter(e => e.who === member).sort((a, b) => a.date.localeCompare(b.date));
  return '<div class="report-bar">' + weekPicker(reportWeek) + exportButton() + '</div>' + metrics([['Total recorded', hours(sumTime(entries))], ['Project work', hours(sumTime(entries.filter(e => e.p != null)))], ['Internal work', hours(sumTime(entries.filter(e => e.p == null)))]]) + tableBox('Time entries', ['Date', 'Work', 'Duration', timeInJira ? 'Comment' : 'Personal note', ''], entries.map(e => {
    const t = state.tasks.find(t => t.id === e.task);
    return [weekdayName(e.date), t ? esc(projects[t.p].name) + '<small class="meta-line">' + esc(t.name) + '</small>' : e.label ? esc(e.label) : 'Internal work', hours(e.minutes), esc(e.note || '—'), '<button data-entry="' + esc(e.id) + '">Edit</button>'];
  }), timeInJira ? 'No time logged in Jira this week. Use Log time to add a work log.' : 'No time recorded this week. Use Log time to add an entry.');
}
function dailyRows(entries) {
  return Array.from({ length: 7 }, (_, i) => {
    const iso = new Date(M.cal.epoch + (reportWeek * 7 + i) * 86400000).toISOString().slice(0, 10);
    return [weekdayName(iso), hours(sumTime(entries.filter(e => e.date === iso)))];
  });
}
function reportView() {
  const pm = role === 'pm', personal = role === 'member', entries = visibleEntries();
  const bar = '<div class="report-bar">' + weekPicker(reportWeek) + exportButton() + (pm ? '<label>Project <select id="pmProject">' + options(me.pmProjects.filter(i => projects[i]).map(i => [i, projects[i].name]), pmProject) + '</select></label>' : '') + '</div>';
  if (pm) {
    const bySystem = systems.map((system, i) => [system, sumTime(entries.filter(e => state.tasks.find(t => t.id === e.task)?.s === i))]).filter(([, n]) => n > 0).map(([system, n]) => [esc(system), hours(n)]);
    const current = finish(state, plan, pmProject), p = projects[pmProject];
    if (!p) return bar + '<p class="empty">No projects are assigned to you yet.</p>';
    return bar + metrics([['Project hours this week', hours(sumTime(entries))], ['Current milestone forecast', fmt(current)], ['Requested milestone', dueText(p)]]) + tableBox('Time by system', ['System', 'Recorded time'], bySystem, 'No project hours recorded this week.') + tableBox('Project time by day', ['Date', 'Logged project time'], dailyRows(entries), '') + '<button data-page="outlook">Open project outlook →</button>';
  }
  const stats = metrics([['Recorded hours', hours(sumTime(entries))], ['Project work', hours(sumTime(entries.filter(e => e.p != null)))], ['Internal work', hours(sumTime(entries.filter(e => e.p == null)))]]);
  const groups = tableBox('Time by project', ['Project or category', 'Recorded time'], projectTotals(entries), 'No entries for this period.');
  if (personal) return bar + stats + groups + tableBox('Daily totals', ['Date', 'Recorded time'], dailyRows(entries), '');
  return bar + stats + tableBox('Team time summary', ['Member', 'Project work', 'Internal work', 'Total'], active(people).map(([p, i]) => {
    const mine = entries.filter(e => e.who === i);
    return [esc(p.name), hours(sumTime(mine.filter(e => e.p != null))), hours(sumTime(mine.filter(e => e.p == null))), hours(sumTime(mine))];
  }), '') + groups;
}
function logForm(existing, taskId) {
  if (role !== 'member' || (existing && existing.who !== member)) return;
  const e = existing ?? { task: taskId || '', date: M.cal.isoOfDay(reportWeek * 5), minutes: 60, note: '' };
  const internal = settings.general.internalIssue;
  const choices = [
    ...(!timeInJira ? [['', 'Internal work']] : internal ? [['', 'Internal work (' + internal + ')']] : []),
    ...state.tasks.filter(t => (!timeInJira || t.key) && (t.actual == null || t.id === e.task)).map(t => [t.id, projects[t.p].name + ' / ' + (t.key ? t.key + ' ' : '') + t.name])
  ];
  if (!choices.length) return modal('Log time', '<p>Time is logged on Jira issues, and none are planned for you yet. Ask the team manager to refresh from Jira.</p><div class="actions"><button data-dismiss>Close</button></div>');
  modal(existing ? 'Edit time entry' : 'Log time', '<form id="logForm" data-id="' + esc(existing?.id || '') + '"><div class="formgrid">' + selectField('Work', 'entryTask', choices, e.task || '', true) + '<label class="field full">Date<input type="date" name="when" required value="' + esc(e.date) + '"></label><label class="field">Hours<input type="number" name="hours" min="0" max="24" step="1" value="' + Math.floor(e.minutes / 60) + '" required></label><label class="field">Minutes<input type="number" name="minutes" min="0" max="59" step="1" value="' + e.minutes % 60 + '" required></label><label class="field full">' + (timeInJira ? 'Comment (visible in Jira)' : 'Personal note (optional)') + '<textarea name="note" rows="2" maxlength="400">' + esc(e.note) + '</textarea></label></div><p role="alert" id="logError" class="late"></p><div class="actions">' + (existing ? '<button type="button" data-remove-log="' + esc(existing.id) + '">Delete entry</button>' : '') + '<button type="button" data-dismiss>Cancel</button><button class="primary">Save time</button></div></form>');
}
$('memberPreview').onchange = () => {
  member = Number($('memberPreview').value);
  try { sessionStorage.setItem('relay.preview.member', String(member)); } catch {}
  announce(''); $('body').replaceChildren(); render();
};
document.addEventListener('submit', async event => {
  if (event.target.id !== 'logForm' || role !== 'member') return;
  event.preventDefault();
  const data = new FormData(event.target), minutes = Number(data.get('hours')) * 60 + Number(data.get('minutes')), dateValue = data.get('when');
  if (minutes <= 0) { $('logError').textContent = 'Enter a positive duration.'; return; }
  const old = state.logs.find(x => x.id === event.target.dataset.id);
  // Demo entries get their id here so a retry overwrites; Jira assigns work log ids itself.
  const entry = { id: old?.id ?? (timeInJira ? undefined : crypto.randomUUID()), issue: old?.issue, prevTask: old ? old.task ?? '' : undefined, prevDate: old?.date, task: data.get('entryTask') || '', date: dateValue, minutes, note: data.get('note') };
  const ok = await send({ kind: 'log', entry }, (timeInJira ? 'Logged in Jira · ' : 'Time saved · ') + hours(minutes) + ' on ' + weekdayName(dateValue) + '.');
  if (ok) { reportWeek = logWeek(dateValue); render(); }
});
document.addEventListener('click', event => {
  const b = event.target.closest('button'); if (!b) return;
  if (b.dataset.page) { tab = b.dataset.page; render(); }
  if (b.hasAttribute('data-export')) exportCsv();
  if (b.dataset.push) pushToJira(b.dataset.pushTask, b.dataset.push);
  if (b.dataset.period) {
    reportWeek = Math.max(0, reportWeek + Number(b.dataset.period));
    load();
  }
  if (role !== 'member') return;
  if (b.dataset.logTask) logForm(null, b.dataset.logTask);
  if (b.dataset.entry) logForm(state.logs.find(e => e.id === b.dataset.entry));
  if (b.dataset.removeLog) modal('Delete time entry?', '<p>This removes the recorded hours from your timesheet and the weekly reports.</p><div class="actions"><button data-dismiss>Cancel</button><button class="primary" data-delete-log="' + esc(b.dataset.removeLog) + '">Delete entry</button></div>');
  if (b.dataset.deleteLog) { const old = state.logs.find(x => x.id === b.dataset.deleteLog); send({ kind: 'deleteLog', id: old?.id, issue: old?.issue, date: old?.date }, 'Time entry deleted.'); }
});

load();
