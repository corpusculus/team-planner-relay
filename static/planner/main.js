// Relay planner UI (ported from team-planner.html). The backend owns the plan; this page previews and sends changes.
import { createModel, leaveMode, absenceIssue, LEAVE_REASONS } from '../../src/shared/model.js';
import { estimate, toSlots } from '../../src/shared/estimate.js';
import { call, openIssue, isLocal, session } from '../common/backend.js';
import { $, esc, options, modal } from '../common/ui.js';
import { rulesHtml } from '../common/rules.js';

const colors = [['#248275', '#d8eee8', '#184e46'], ['#7460a8', '#e9e3f5', '#493c69'], ['#ad7331', '#f5e9d4', '#6e4d24'], ['#4676a4', '#dfeaf5', '#304e70'], ['#aa626b', '#f6e4e5', '#6b3c44'], ['#68813f', '#e8efd9', '#455827'],
  ['#a04f93', '#f3e1ef', '#662f5d'], ['#2f8fa3', '#d9eef2', '#1d5a67'], ['#b5553c', '#f7e2db', '#74331f'], ['#5560b8', '#e1e4f7', '#353d7a'], ['#4d9150', '#deefdd', '#2d5c30'], ['#9c8a1f', '#f3efcf', '#5f5410'],
  ['#6b7785', '#e6e9ed', '#3f4852'], ['#c25f8f', '#f8e2ec', '#7a3556'], ['#8a6248', '#efe4db', '#573c2a']];

// Workspace (set by useWorkspace)
let settings, today, me, M, people, projects, systems, types, state, plan;
let teams = [], undo = null;
try { session.team = sessionStorage.getItem('relay.team') ?? undefined; } catch {}
let fmt, span, slotLabel, hrs, leaveText, daysLate, dueText, who, effectiveWork, duration, spent, statusOf, eligible, finish, off, take;
let spd, slotH, weekSlots, timeInJira = false;
// View state
let role = 'member', pmProject = 0, member = 2;
try { const last = sessionStorage.getItem('relay.preview.role'); if (['member', 'team', 'pm'].includes(last)) role = last; const w = sessionStorage.getItem('relay.preview.member'); if (w !== null) member = Number(w); } catch {}
let accuracyBy = 'type', period = null, pmCal = 'all', personFilter = 'all', tab = role === 'pm' ? 'outlook' : 'home', filter = 'all', showAll = false, draft = null, formValues = null, busy = false, booted = false;

function useWorkspace(ws) {
  settings = ws.settings; today = ws.today; me = ws.me; state = ws.state;
  M = createModel(settings, today);
  if (ws.teams) { teams = ws.teams; session.team = ws.team; }
  undo = ws.undo ?? null;
  ({ people, projects, systems, types, fmt, span, slotLabel, hrs, leaveText, daysLate, dueText, who, effectiveWork, duration, spent, statusOf, eligible, finish, off, take, spd, slotH, weekSlots } = M);
  if (!me.demo) { role = me.access; member = me.person; }
  if (role === 'pm' && !me.pmProjects.includes(pmProject)) pmProject = me.pmProjects[0] ?? 0;
  if (!people[member]) member = 0;
  plan = M.schedule(state);
  timeInJira = !!ws.timeInJira;
  if (!booted) { booted = true; setPeriod('week', anchorDay()); tab = role === 'pm' ? 'outlook' : 'home'; }
}
const demoCtx = () => ({ role, member });
// ---- Period shown by every calendar, timesheet and report: a day, week, month or custom range (ISO dates) ----
const DAY = 86400000, MAX_DAYS = 62;
const isoAdd = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const weekday = iso => new Date(iso + 'T00:00:00Z').getUTCDay();
const anchorDay = () => (today < settings.general.planStart ? settings.general.planStart : today);
function setPeriod(mode, anchor) {
  if (mode === 'day') { let d = anchor; while (weekday(d) % 6 === 0) d = isoAdd(d, 1); period = { mode, from: d, to: d }; }
  else if (mode === 'month') { const [y, m] = anchor.split('-').map(Number); period = { mode, from: new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10), to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) }; }
  else { const monday = isoAdd(anchor, -((weekday(anchor) + 6) % 7)); period = { mode: 'week', from: monday, to: isoAdd(monday, 6) }; }
}
function shiftPeriod(dir) {
  const { mode, from, to } = period;
  if (mode === 'day') { let d = isoAdd(from, dir); while (weekday(d) % 6 === 0) d = isoAdd(d, dir); setPeriod('day', d); }
  else if (mode === 'week') setPeriod('week', isoAdd(from, 7 * dir));
  else if (mode === 'month') { const [y, m] = from.split('-').map(Number); setPeriod('month', new Date(Date.UTC(y, m - 1 + dir, 1)).toISOString().slice(0, 10)); }
  else { const len = (Date.parse(to) - Date.parse(from)) / DAY + 1; period = { mode, from: isoAdd(from, len * dir), to: isoAdd(to, len * dir) }; }
}
const periodRange = () => (period ? { from: period.from, to: period.to } : undefined);
/** First and last workday index of the period (empty when last < first). */
const periodDays = () => [M.cal.dayIndex(period.from, true), M.cal.dayIndex(period.to)];
const inPeriod = iso => iso >= period.from && iso <= period.to;
function periodLabel() {
  const d = (iso, o) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { ...o, timeZone: 'UTC' });
  if (period.mode === 'day') return d(period.from, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  if (period.mode === 'month') return d(period.from, { month: 'long', year: 'numeric' });
  // A week reads Monday–Friday like the calendar columns; weekend entries still count in its totals.
  return d(period.from, { day: 'numeric', month: 'short' }) + ' – ' + d(period.mode === 'week' ? isoAdd(period.from, 4) : period.to, { day: 'numeric', month: 'short' });
}
/** Day / week / month / custom switch with previous, next and today. */
function periodPicker() {
  return '<div class="period-bar"><select id="periodMode" aria-label="Period">' + options([['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['custom', 'Custom']], period.mode) + '</select>' +
    (period.mode === 'custom'
      ? '<input type="date" id="periodFrom" aria-label="From" value="' + period.from + '"><input type="date" id="periodTo" aria-label="To" value="' + period.to + '"><button id="periodApply">Show</button>'
      : '<div class="period"><button class="arrow" data-shift="-1" aria-label="Previous">‹</button><b>' + periodLabel() + '</b><button class="arrow" data-shift="1" aria-label="Next">›</button></div><button id="periodToday">Today</button>') + '</div>';
}
const startBlocker = t => M.startBlocker(state, plan, t);
/** Coloured status label; `kind` picks the colour and defaults to the text. */
const pill = (text, kind = text) => '<span class="td-status s-' + kind.toLowerCase().replace(/ /g, '-') + '">' + text + '</span>';
const outlookPill = (d, p) => pill(outlookText(d, p), !Number.isFinite(d) ? 'waiting' : d > p.due ? 'late' : 'on-track');
/** Workday index of today, or -1 on weekends and before the plan starts. */
const todayDay = () => (today >= settings.general.planStart && M.cal.isWeekday(today) ? M.cal.dayIndex(today) : -1);
const active = list => list.map((x, i) => [x, i]).filter(([x]) => !x.archived);

async function load(quiet = false) {
  try {
    const ws = await call('getWorkspace', { demo: demoCtx(), range: periodRange() });
    if (ws.notMember) return gate(ws.isAdmin);
    useWorkspace(ws);
    // The first request can't know the period yet (it comes from the calendar), so fetch that period's entries once more.
    if (ws.range && (ws.range.from !== period.from || ws.range.to !== period.to)) return load();
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
    const ws = await call('apply', { op, demo: demoCtx(), opId: crypto.randomUUID(), range: periodRange() });
    useWorkspace(ws);
    if ($('modal').open) $('modal').close();
    render();
    announce(message + (ws.warning ? ' ' + ws.warning : ''));
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
  report: ['Report', ''],
  queue: ['Work queue', 'See what is underway, what can start next, and what needs a decision.'],
  schedule: ['Team calendar', 'Assignments, protected time, and buffers across the team.'],
  coverage: ['Project coverage', 'Primary contacts, backups, and the systems each person covers.'],
  outlook: ['Project outlook', 'Milestone forecasts, agreed starts, and notes shared with the team.']
};

function render() {
  const pm = role === 'pm', personal = role === 'member';
  const pages = personal ? ['home', 'schedule', 'sheet', 'report'] : pm ? ['outlook', 'schedule', 'report'] : ['home', 'queue', 'schedule', 'coverage', 'report'];
  if (!pages.includes(tab)) tab = pages[0];
  $('roleBox').hidden = !me.demo; $('role').value = role;
  $('teamPick').hidden = teams.length < 2; $('teamPick').innerHTML = options(teams.map(t => [t.id, t.name]), session.team);
  $('memberPreview').hidden = !me.demo || !personal;
  $('memberPreview').innerHTML = options(active(people).map(([p, i]) => [i, p.name]), member);
  $('identity').hidden = me.demo; $('identity').textContent = me.demo ? '' : me.name + ' · ' + { member: 'Team member', team: 'Team manager', pm: 'Project manager' }[role];
  $('refresh').hidden = me.demo || role !== 'team';
  $('settingsLink').hidden = !isLocal;
  $('reset').hidden = !(me.demo && role === 'team');
  $('footnote').textContent = me.demo ? 'Demo portfolio · Fictional data · Switch to live mode in Relay settings' : 'Live plan · ' + (state.refreshedAt ? 'Jira refreshed ' + new Date(state.refreshedAt).toLocaleString('en-GB') : 'Not refreshed from Jira yet') + (state.unmapped.length && role === 'team' ? ' · ' + state.unmapped.length + ' Jira issues need mapping (see settings)' : '');
  $('simulate').hidden = !(role === 'team' && ['home', 'queue', 'schedule', 'coverage'].includes(tab) || personal && ['home', 'sheet', 'schedule'].includes(tab));
  $('simulate').textContent = personal ? (tab === 'schedule' ? 'Protect time' : '＋ Log time') : '＋ Add task';
  const ownLeave = personal && tab === 'schedule' && leaveMode(settings.general) !== 'off';
  $('otherChanges').hidden = $('simulate').hidden || (personal && !ownLeave);
  $('otherChanges').textContent = personal ? 'Time off' : 'Other changes';
  const title = tab === 'home' ? (personal ? 'My work' : 'Team overview') : tab === 'sheet' ? 'My timesheet' : tab === 'schedule' && personal ? 'My calendar' : tab === 'schedule' && pm ? 'Project calendar' : tab === 'report' ? (personal ? 'My report' : pm ? 'Project report' : 'Team report') : pageInfo[tab][0];
  $('title').textContent = title;
  const counts = active(people).length + ' people across ' + active(projects).length + ' projects';
  $('intro').textContent = tab === 'home' ? (personal ? who(member).name + ' · ' + (who(member).role || 'Team member') : counts + '. Review available capacity and work that needs a decision.') : tab === 'report' ? (pm ? 'Project hours and delivery outlook for the chosen period.' : personal ? 'Your recorded work for the chosen period.' : 'Hours by person and project for the chosen period.') : (pm && tab === 'schedule' ? 'Who works on your projects and when, and where they are free. Their other work shows as busy time.' : personal && tab === 'schedule' ? 'Your assignments, protected time, and troubleshooting reserves.' : pageInfo[tab][1]);
  for (const k of Object.keys(pageInfo)) {
    const btn = $(k + 'Tab'); btn.hidden = !pages.includes(k);
    if (k === 'home') btn.textContent = personal ? 'My work' : 'Overview';
    btn.classList.toggle('active', k === tab); btn.setAttribute('aria-current', k === tab ? 'page' : 'false');
  }
  const views = { home: personal ? memberHome : managerHome, queue: queueView, schedule: () => (role === 'pm' ? pmCalendarHeader() : board()), coverage, outlook: pmView, sheet: timesheetView, report: reportView };
  $('view').innerHTML = views[tab]();
  // Phones show table rows as labelled blocks (CSS .stack); labels come from the header cells.
  for (const table of $('view').querySelectorAll('table.data:not(.load-table)')) {
    const heads = [...table.querySelectorAll('th')].map(th => th.textContent);
    table.classList.add('stack');
    for (const row of table.tBodies[0]?.rows ?? []) [...row.cells].forEach((td, i) => { td.dataset.label = heads[i] ?? ''; });
  }
}

function board() {
  // A project manager sees the people on their project; work on other projects only as busy time.
  const canLeave = role === 'team' || (role === 'member' && leaveMode(settings.general) !== 'off');
  const pmMode = role === 'pm', mine = pmMode ? (pmCal === 'all' ? me.pmProjects : [Number(pmCal)]) : [];
  const onProject = w => mine.some(i => projects[i] && (w === projects[i].lead || w === projects[i].back)) || state.tasks.some(t => mine.includes(t.p) && plan.get(t.id)?.who === w);
  const busy = '<div class="block other" style="STYLE" title="Busy with other work"><b>Other work</b><small>Busy</small></div>';
  const [d0, d1] = periodDays(), days = Math.max(0, d1 - d0 + 1), start = d0 * spd, cols = days * spd, dense = days > 10;
  /** A block that is not a task: its two lines double as the hover text, since narrow blocks cut them off. */
  const plain = (css, title, sub, attrs = '') => '<' + (attrs ? 'button' : 'div') + ' class="block ' + css + '" ' + attrs + ' style="STYLE" title="' + esc(title + ' · ' + sub) + '"><b>' + esc(title) + '</b><small>' + esc(sub) + '</small></' + (attrs ? 'button' : 'div') + '>';
  const t0 = (todayDay() - d0) * spd, todayCol = t0 >= 0 && t0 < cols ? '<i class="today-col" style="grid-row:1;grid-column:' + (t0 + 1) + '/span ' + spd + '"></i>' : '';
  const rows = people.map((p, w) => {
    if (p.archived || (role === 'member' && w !== member) || (role === 'pm' && !onProject(w))) return '';
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
      if (pmMode && !mine.includes(t.p)) {
        for (const h of t.history || []) if (h.who === w) add(h.start, h.end, busy);
        const x = plan.get(t.id);
        if (x.who === w && Number.isFinite(x.start)) addWorking(x.start, x.end, busy);
        continue;
      }
      for (const h of t.history || []) if (h.who === w) add(h.start, h.end, '<button class="block done" data-task="' + t.id + '" style="STYLE' + color(t.p) + '" title="' + esc(projects[t.p].name + ' · Worked · ' + t.name) + '"><b>' + esc(projects[t.p].name) + '</b><small>Worked · ' + esc(t.name) + '</small></button>');
      const x = plan.get(t.id);
      if (!Number.isFinite(x.start)) {
        const fixed = state.fixed.find(f => f.taskId === t.id);
        if (fixed && t.firstStart == null && x.who === w) add(fixed.start, fixed.start + duration(t), '<button class="block meeting fixed" data-task="' + t.id + '" style="STYLE' + color(t.p) + '" title="' + esc(projects[t.p].name + ' · ' + t.name + ' · Fixed start · At risk') + '"><b>' + esc(projects[t.p].name) + '</b><small>Fixed start · At risk</small></button>');
        continue;
      }
      if (x.who !== w) continue;
      const fixed = state.fixed.some(f => f.taskId === t.id), workEnd = Math.min(x.end, take(w, x.start, Math.max(1, effectiveWork(t) - spent(t))).at(-1) + 1);
      const label = t.actual != null ? 'Done · ' : t.started ? 'In progress · ' : fixed ? 'Fixed start · ' : '';
      const card = (css, title, subtitle) => '<button class="block ' + css + '" data-task="' + t.id + '" style="STYLE' + color(t.p) + '" title="' + esc(projects[t.p].name + ' · ' + t.name + ' · ' + subtitle) + '"><b>' + esc(title) + '</b><small>' + esc(subtitle) + '</small></button>';
      // The team manager drags a task that has not started to another day or person; that sets a fixed start there.
      const drag = role === 'team' && !t.started && !t.wait && t.actual == null && t.firstStart == null ? '" draggable="true" data-drag="' + t.id : '';
      addWorking(x.start, workEnd, card((fixed ? 'meeting fixed ' : '') + (t.actual != null ? 'done' : '') + drag, projects[t.p].name, label + t.name));
      if (workEnd < x.end) addWorking(workEnd, x.end, card('buffer', 'Buffer', projects[t.p].name + ' · ' + t.name));
    }
    for (const block of state.privateTime.filter(x => x.who === w)) add(block.start, block.start + block.len, pmMode ? plain('private', 'Unavailable', 'Private time') : plain('private', dense ? 'Private' : 'Private time', block.name, 'data-private="' + block.id + '"'));
    // One block per time-off entry, so it can be opened to reschedule or remove it.
    for (const l of state.leave.filter(l => l.who === w)) add(l.start, l.start + l.len, plain('away', 'Time off', l.reason || 'Unavailable', canLeave ? 'data-leave-who="' + w + '" data-leave-start="' + l.start + '"' : ''));
    for (let d = start; d < start + cols; d++) { if (!off(w, d)) continue; let e = d + 1; while (e < start + cols && off(w, e)) e++; add(d, e, M.isHoliday(d) ? plain('away', 'Holiday', 'Public holiday') : plain('away', dense ? 'Off' : 'Not working', 'Outside working hours')); d = e - 1; }
    // Free time from now on, so managers can see where a task fits; clicking it starts "Add a task" there.
    const load = role === 'member' ? [] : loadSlots(start, cols, w).map((k, i) => (k === 'free' && start + i < M.now ? 'past' : k));
    for (let d = 0; d < load.length; d++) { if (load[d] !== 'free') continue; let e = d + 1; while (e < load.length && load[e] === 'free') e++; add(start + d, start + e, '<button class="block free" data-free-who="' + w + '" data-free-start="' + (start + d) + '" data-free-hours="' + (e - d) * slotH + '" style="STYLE" title="Free · ' + (e - d) * slotH + 'h · Add a task here"><b>Free · ' + (e - d) * slotH + 'h</b><small>Add a task</small></button>'); d = e - 1; }
    const freeHours = load.filter(k => k === 'free').length * slotH;
    return '<div class="person grid"><div class="who"><span class="avatar">' + esc(p.initials) + '</span><div><b>' + esc(p.name) + '</b><small>' + (role === 'member' ? esc(p.role || '') : '<span class="free-h">' + freeHours + 'h free</span>') + '</small></div></div><div class="lane" data-who="' + w + '" data-start="' + start + '" data-cols="' + cols + '" style="grid-template-columns:repeat(' + cols + ',minmax(0,1fr))">' + todayCol + blocks.join('') + '</div></div>';
  }).join('');
  const key = (css, text) => '<span><i class="block ' + css + '"></i>' + text + '</span>';
  const legend = '<div class="legend" style="' + color(0) + '">' + key('', 'Planned work') + key('buffer', 'Buffer for troubleshooting') + key('private', 'Private time') + key('away', 'Away or not working') + (pmMode ? key('other', 'Other work') : '') + (role === 'member' ? '' : key('free', 'Free')) + '<span>' + slotH + 'h slots</span></div>';
  const head = '<div class="section-head">' + periodPicker() + (role === 'team' ? '<span class="sub">Drag a task to move it</span>' : '') + '</div>' + myRequests();
  if (!days) return '<section class="panel">' + head + '<p class="empty">No workdays in this period.</p></section>';
  return '<section class="panel">' + head + '<div class="scroll"><div class="board" style="--days:' + days + ';min-width:' + Math.max(750, 175 + days * (dense ? 100 : 110)) + 'px"><div class="grid days"><div>Team member</div>' + Array.from({ length: days }, (_, i) => '<div' + (d0 + i === todayDay() ? ' class="today"' : '') + '>' + fmt(start + i * spd, { weekday: 'short', day: 'numeric' }) + (d0 + i === todayDay() ? ' · Today' : '') + (M.isHoliday(start + i * spd) ? ' · Holiday' : '') + '</div>').join('') + '</div>' + rows + '</div></div><div class="foot">' + legend + '</div></section>';
}

function milestones() {
  const indices = active(projects).map(([, i]) => i).filter(i => filter === 'all' || String(i) === filter), list = showAll ? indices : indices.slice(0, 5);
  return '<section class="panel" id="milestones"><div class="section-head"><div><h2>Project milestones</h2><p>Forecast completion of each project’s planned work.</p></div><select id="filter" aria-label="Filter milestones by project"><option value="all">All projects</option>' + active(projects).map(([p, i]) => '<option value="' + i + '" ' + (filter === String(i) ? 'selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select></div><div class="scroll"><table class="data"><thead><tr><th>Project</th><th>Primary</th><th>Requested by</th><th>Forecast</th><th>Outlook</th></tr></thead><tbody>' + list.map(i => { const d = finish(state, plan, i), p = projects[i]; return '<tr><td>' + projectLink(i) + '</td><td>' + esc(who(p.lead).short) + '</td><td>' + dueText(p) + '</td><td>' + fmt(d) + '</td><td>' + outlookPill(d, p) + '</td></tr>'; }).join('') + '</tbody></table></div>' + (indices.length > 5 ? '<div class="foot"><span>' + list.length + ' of ' + indices.length + ' projects</span><button class="link" id="more">' + (showAll ? 'Show fewer' : 'Show all projects') + '</button></div>' : '') + '</section>';
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
    return '<tr><td><button class="link" data-task="' + t.id + '">' + esc(t.name) + '</button><small class="meta-line">' + esc(projects[t.p].name) + ' / ' + esc(systems[t.s]) + keyTag(t) + '</small></td><td>' + esc(who(x.who).name) + (assigneeNote(t, x) ? '<small class="meta-line">⚠ ' + esc(assigneeNote(t, x)) + '</small>' : '') + '</td><td>' + span(x.start, x.end - 1) + '</td><td>' + pill(statusOf(t)) + '</td></tr>';
  }
  const table = group => '<div class="scroll"><table class="data"><thead><tr><th>Task and system</th><th>Owner</th><th>Work window</th><th>State</th></tr></thead><tbody>' + group.map(row).join('') + '</tbody></table></div>';
  return '<div class="queue-tools"><label>Team member <select id="personFilter">' + options([['all', 'Everyone'], ...active(people).map(([p, i]) => [i, p.name])], personFilter) + '</select></label></div><div class="swimlanes">' + lane('In progress', 'running', running, 'No active work for this selection.') + lane('Next to start', 'ready', ready, 'Upcoming work is waiting for capacity or a prerequisite.') + lane('Waiting', 'waiting', waiting, 'No external blockers recorded.') + '</div><section class="panel"><div class="section-head"><div><h2>Portfolio queue</h2><p>Tasks in priority order, including dependent work.</p></div><span class="sub">' + items.length + ' tasks</span></div>' + (items.length ? table(items.slice(0, 5)) : '<p class="empty">No tasks yet. ' + (me.demo ? '' : 'Use Refresh from Jira, or add a task.') + '</p>') + (items.length > 5 ? '<details><summary class="more-summary">Show remaining ' + (items.length - 5) + ' tasks</summary>' + table(items.slice(5)) + '</details>' : '') + '</section>';
}

function taskDetail(id) {
  if ((role === 'pm' && !me.pmProjects.includes(state.tasks.find(t => t.id === id)?.p)) || (role === 'member' && plan.get(id)?.who !== member)) return;
  const t = state.tasks.find(t => t.id === id), x = plan.get(id), blocker = t.started ? '' : startBlocker(t);
  let actions = '';
  if (!t.started && !t.wait) actions = (role === 'team' ? '<button ' + (t.firstStart != null ? 'disabled' : '') + ' data-timing="' + id + '">' + (state.fixed.some(f => f.taskId === id) ? 'Edit fixed start' : 'Set a fixed start') + '</button>' : '') + '<button data-estimate="' + id + '">Edit estimate</button><button class="primary" data-start="' + id + '" ' + (blocker ? 'disabled' : '') + '>Start on ' + slotLabel(x.start) + '</button>';
  if (t.wait) actions = '<button class="primary" data-resume="' + id + '">Resolve blocker</button>';
  if (t.started && t.actual == null) actions = '<button data-pause="' + id + '">Mark waiting</button><button data-revise="' + id + '">Update expected duration</button><button class="primary" data-finish="' + id + '">Record finish</button>';
  if (role === 'member' && (!timeInJira || t.key)) actions += '<button data-log-task="' + id + '">Log time</button>';
  if (role === 'team' && !me.demo && t.key && Number.isFinite(x.end)) actions += '<button data-push="assignee" data-push-task="' + id + '">Set Jira assignee to ' + esc(who(x.who).short) + '</button><button data-push="duedate" data-push-task="' + id + '">Set Jira due date to ' + fmt(x.end - 1) + '</button>';
  if (role === 'pm') actions = ''; // read-only for project managers
  if (t.key) actions = '<button data-issue="' + esc(t.key) + '">Open ' + esc(t.key) + ' in Jira</button>' + actions;
  modal(t.name, taskCard(t, x, actions, blocker));
}
/** Visual task details: status, owner and dates, an effort bar, key numbers, people and prerequisites. */
function taskCard(t, x, actions, blocker) {
  const status = statusOf(t), owner = who(x.who), expected = effectiveWork(t), done = t.actual ?? spent(t);
  const workLeft = t.actual != null ? 0 : Math.max(0, expected - spent(t)), bufferLeft = t.actual != null ? 0 : Math.max(0, duration(t) - expected);
  const total = Math.max(1, done + workLeft + bufferLeft), pct = n => (100 * n / total).toFixed(1) + '%';
  const days = Number.isFinite(x.start) ? new Set(Array.from({ length: x.end - x.start }, (_, k) => Math.floor((x.start + k) / spd))).size : 0;
  const segments = [[done, 'spent', t.actual != null ? 'Actual' : 'Spent'], [workLeft, 'work', 'Work left'], [bufferLeft, 'buffer', 'Buffer left']];
  const avatar = w => '<span class="avatar">' + esc(who(w).initials) + '</span>';
  const deps = (t.deps ?? []).map(d => state.tasks.find(z => z.id === d)).filter(Boolean);
  const label = text => '<div class="td-label">' + text + '</div>';
  return '<div class="td" style="' + color(t.p) + '">' +
    '<div class="td-head">' + pill(status) + '<span class="td-proj"><i class="dot"></i>' + esc(projects[t.p].name) + ' / ' + esc(systems[t.s]) + '</span>' + (t.key ? '<span class="tag">' + esc(t.key) + '</span>' : '') + (types[t.type] ? '<span class="tag">' + esc(types[t.type].name) + '</span>' : '') + '</div>' +
    '<div class="td-when"><div class="td-owner">' + avatar(x.who) + '<div><b>' + esc(owner.name) + '</b><small>' + esc(owner.role || 'Planned owner') + '</small></div></div><div class="td-dates"><small>Forecast</small><b>' + span(x.start, x.end - 1) + '</b><small>' + (days ? days + ' workday' + (days === 1 ? '' : 's') : t.wait ? 'Paused' : 'After its prerequisites') + '</small></div></div>' +
    (t.wait ? '<p class="wait-note"><b>Waiting for</b> ' + esc(t.wait.reason) + '</p>' : '') +
    (t.gone ? '<p class="td-warn">No longer in the Jira filter.</p>' : '') +
    (assigneeNote(t, x) ? '<p class="td-warn">⚠ Jira assignee is ' + esc(t.assignee.name) + ', the plan says ' + esc(owner.name) + '.</p>' : '') +
    label('Effort') +
    '<div class="effort-bar" role="img" aria-label="' + segments.map(([n, , l]) => l + ' ' + hrs(n)).join(', ') + '">' + segments.filter(([n]) => n > 0).map(([n, k]) => '<span class="seg seg-' + k + '" style="width:' + pct(n) + '"></span>').join('') + '</div>' +
    '<div class="effort-legend">' + segments.map(([n, k, l]) => '<span><i class="seg-' + k + '"></i>' + l + ' ' + hrs(n) + '</span>').join('') + '</div>' +
    '<div class="td-stats">' + [['Estimated work', hrs(t.work)], ['Planned buffer', hrs(t.buffer)]].map(([l, v]) => '<div><small>' + l + '</small><b>' + v + '</b></div>').join('') + '</div>' +
    '<p class="source">Estimate: ' + esc(t.source || '—') + '</p>' +
    label('Who can do it') + '<div class="chip-row">' + (eligible(t).map(w => '<span class="person-chip' + (w === x.who ? ' on' : '') + '">' + avatar(w) + esc(people[w].name) + '</span>').join('') || '<span class="sub">Nobody covers this system.</span>') + '</div>' +
    label('Depends on') + '<div class="chip-row">' + (deps.map(d => '<span class="dep-chip' + (d.actual != null ? ' ok' : '') + '">' + (d.actual != null ? '✓ ' : '○ ') + esc(d.name) + '</span>').join('') || '<span class="sub">Nothing — ready when its owner is free.</span>') + '</div>' +
    (t.assignee && !assigneeNote(t, x) ? '<p class="sub td-jira">Jira assignee: ' + esc(t.assignee.name) + '</p>' : '') +
    '<div class="task-actions">' + (role === 'team' ? '<button data-project="' + t.p + '">View project</button>' : '') + actions + '</div>' +
    (blocker ? '<p class="sub">' + esc(blocker) + '</p>' : '') + '</div>';
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
  const kind = v.kind || 'queued', isTask = kind === 'urgent' || kind === 'queued', p = Number(v.p ?? (role === 'pm' ? me.pmProjects[0] : active(projects)[0]?.[1]) ?? 0);
  const dates = Array.from({ length: (endWeek() + 2) * weekSlots }, (_, i) => i).filter(i => i >= M.now).map(i => [i, slotLabel(i)]);
  const dayDates = dates.filter(([i]) => i % spd === 0).map(([i]) => [i, fmt(i, { weekday: 'short', month: 'short', day: 'numeric' })]);
  const hourChoices = Array.from({ length: 20 }, (_, i) => [(i + 1) * slotH, (i + 1) * slotH + 'h']);
  const dayChoices = Array.from({ length: 60 }, (_, i) => [i + 1, (i + 1) + ' workday' + (i ? 's' : '')]);
  const footer = '<div class="actions"><button type="button" data-dismiss>Cancel</button><button class="primary" type="submit">Preview impact →</button></div>';
  if (['estimate', 'finish', 'revise'].includes(kind)) {
    const t = state.tasks.find(t => t.id === v.taskId);
    const fields = kind === 'estimate' ? hourInput('Estimated hours', 'hours', v.hours ?? t.work * slotH, slotH) + hourInput('Buffer hours', 'buffer', v.buffer ?? t.buffer * slotH, 0) : hourInput(kind === 'finish' ? 'Actual hours from start' : 'Expected total hours from start', 'hours', v.hours ?? effectiveWork(t) * slotH, slotH);
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
    modal('Task timing', '<p><b>' + esc(projects[task.p].name) + ' · ' + esc(task.name) + '</b><br>Currently planned for ' + slotLabel(plan.get(task.id).start) + '.</p><form id="changeForm"><input type="hidden" name="kind" value="timing"><input type="hidden" name="taskId" value="' + task.id + '">' + (v.prefer != null && v.prefer !== '' ? '<input type="hidden" name="prefer" value="' + esc(v.prefer) + '"><p class="source">Preferred owner: ' + esc(who(Number(v.prefer)).name) + '</p>' : '') + '<label class="field">Fixed start date (optional)<input type="date" name="stamp" min="' + settings.general.planStart + '" value="' + esc(stamp) + '"></label><p class="sub">Use an agreed date to anchor the start and share this task and date with the PM. Leave blank for flexible scheduling.</p>' + footer + '</form>');
    return;
  }
  // Rescheduling time off (`from` is the entry's current start) keeps the person and the kind of change fixed.
  const moving = kind === 'leave' && v.from != null && v.from !== '', current = moving && state.leave.find(l => l.who === Number(v.who) && l.start === Number(v.from));
  let fields = role === 'pm' ? '<input type="hidden" name="kind" value="queued">' : (role === 'member' && !isTask) || moving ? '<input type="hidden" name="kind" value="' + kind + '"><input type="hidden" name="who" value="' + (role === 'member' ? member : Number(v.who)) + '">' : isTask ? selectField('Priority', 'kind', [['queued', 'Normal: joins the queue'], ['urgent', 'Urgent: goes first']], kind, true) : selectField('Change', 'kind', [['leave', 'Mark a person away'], ...(state.tasks.some(t => t.actual == null) ? [['extend', 'Extend an existing task']] : []), ['private', 'Protect private team time']], kind, true);
  if (isTask) {
    const typeList = active(types), type = Number(v.type ?? typeList[typeList.length - 1]?.[1] ?? 0);
    const sys = projects[p]?.systems ?? [], s = sys.includes(Number(v.s)) ? Number(v.s) : sys.includes(types[type]?.system) ? types[type].system : sys[0];
    const est = s == null ? null : estimate(settings, { type, p, s }, state.completed, today);
    const estHours = est ? Math.max(1, toSlots(est.hours, slotH)) * slotH : slotH, estBuffer = est ? toSlots(est.buffer, slotH) * slotH : 0;
    fields += selectField('Task type', 'type', typeList.map(([a, i]) => [i, a.name]), type, true);
    fields += '<label class="field full">Task name<input required maxlength="70" name="name" value="' + esc(v.name ?? (kind === 'urgent' ? 'Urgent ' + types[type].name.toLowerCase() : types[type].name)) + '"></label>' + selectField('Project', 'p', active(projects).filter(([, i]) => role !== 'pm' || me.pmProjects.includes(i)).map(([x, i]) => [i, x.name]), p) + selectField('System', 's', sys.map(x => [x, systems[x]]), s) + selectField('Earliest start', 'start', dates, v.start ?? Math.max(periodDays()[0] * spd, M.now)) + hourInput('Estimated hours', 'hours', v.keepHours ? v.hours : estHours, slotH) + hourInput('Buffer hours', 'buffer', v.keepHours ? v.buffer : estBuffer, 0) + (v.prefer != null && v.prefer !== '' ? '<input type="hidden" name="prefer" value="' + esc(v.prefer) + '"><input type="hidden" name="fit" value="' + esc(v.fit ?? '') + '"><p class="source full">Preferred owner: ' + esc(who(Number(v.prefer)).name) + ', from ' + slotLabel(Number(v.start)) + '</p>' + (v.fit && estHours + estBuffer > Number(v.fit) ? '<p class="td-warn full">This free time holds ' + v.fit + 'h, but the task needs ' + (estHours + estBuffer) + 'h with buffer. Work is planned as one block, so it will start later. Shorten it to fit, or check the preview.</p>' : '') : '') + '<input type="hidden" name="source" value="' + esc(est?.source ?? '') + '"><input type="hidden" name="estHours" value="' + estHours + '"><p class="source full">' + (est ? 'Suggested: ' + estHours + 'h + ' + estBuffer + 'h buffer · ' + esc(est.source) : 'Nobody on this project covers a system yet.') + '</p>';
  }
  if (kind === 'private') {
    const block = state.privateTime.find(b => b.id === v.blockId);
    fields += (block ? '<input type="hidden" name="blockId" value="' + esc(block.id) + '">' : '') +
      '<label class="field full">Private work label<input name="name" maxlength="70" required value="' + esc(v.name ?? 'Focus time') + '"></label>' +
      (role === 'member' ? '' : selectField('Team member', 'who', active(people).map(([x, i]) => [i, x.name]), v.who ?? 0, true)) +
      selectField('First protected slot', 'start', dates, v.start ?? Math.max(periodDays()[0] * spd, M.now)) + selectField('Duration', 'hours', hourChoices, v.hours ?? (v.len ? v.len * slotH : settings.general.workdayHours)) +
      (block ? '' : selectField('Repeat', 'repeat', [[1, 'Does not repeat'], ...Array.from({ length: 25 }, (_, k) => [k + 2, 'Every week, ' + (k + 2) + ' times'])], v.repeat ?? 1, true));
  }
  // Time off is counted in slots, so part of a day (a slot of a few hours) works too.
  const leaveLengths = [...Array.from({ length: spd - 1 }, (_, k) => [k + 1, hrs(k + 1)]), ...dayChoices.map(([d, l]) => [d * spd, l])];
  if (kind === 'leave') fields += (moving ? '<input type="hidden" name="from" value="' + Number(v.from) + '">' : '') + (role === 'member' || moving ? '' : selectField('Team member', 'who', active(people).map(([x, i]) => [i, x.name]), v.who ?? 0, true)) + selectField('From', 'start', spd > 1 ? dates : dayDates, v.start ?? Math.max(periodDays()[0] * spd, M.now)) + selectField('Time away', 'len', leaveLengths, v.len ?? 2 * spd) + selectField('Reason', 'reason', [['', 'Not given'], ...LEAVE_REASONS.map(r => [r, r])], v.reason ?? '', true) + '<p class="source full">Only the team manager' + (role === 'member' ? ' and you see' : ' and the person see') + ' the reason.</p>';
  if (kind === 'extend') fields += selectField('Task', 'taskId', state.tasks.filter(t => t.actual == null).map(t => [t.id, projects[t.p].name + ' · ' + t.name]), v.taskId, true) + selectField('Additional expected hours', 'hours', hourChoices, v.hours ?? slotH, true);
  const adding = isTask;
  modal(adding ? 'Add a task' : moving ? (requesting() ? 'Request new dates' : 'Reschedule time off') : kind === 'leave' && role === 'member' ? (requesting() ? 'Request time off' : 'Time off') : role === 'member' ? 'Protect time' : 'Change the plan', '<p>' + (adding ? 'Preview where it lands and what it moves before you apply it.' : current ? esc(who(current.who).name) + ' is away ' + leaveText(current) + '. Choose the new dates.' : kind === 'leave' && requesting() ? 'Preview the effect, then send the request. It counts once the team manager approves it.' : 'Preview the effect on the published schedule. You decide whether to apply it.') + '</p><form id="changeForm"><div class="formgrid">' + fields + '</div>' + footer + '</form>');
}

function preview(v) {
  if ((v.kind === 'urgent' || v.kind === 'queued') && Number(v.hours) !== Number(v.estHours)) v.source = 'Entered in Relay';
  formValues = v; draft = M.makeDraft(state, plan, v);
  const { next, slots, moved, summary } = draft;
  const changed = projects.map((p, i) => ({ p, i, old: finish(state, plan, i), now: finish(next, slots, i) })).filter(x => x.old !== x.now);
  if (role === 'member') {
    const own = moved.filter(t => plan.get(t.id).who === member || slots.get(t.id).who === member);
    modal('Change preview', '<p>' + esc(summary) + '</p><div class="note">' + own.length + ' of your assignments change.</div>' + own.map(t => '<div class="detail">' + esc(projects[t.p].name) + ' · ' + esc(t.name) + '<small>' + span(plan.get(t.id).start, plan.get(t.id).end - 1) + ' → ' + span(slots.get(t.id).start, slots.get(t.id).end - 1) + '</small></div>').join('') + '<div class="actions"><button data-dismiss>Discard</button><button class="primary" id="apply">' + (requesting() && v.kind === 'leave' ? 'Send request' : 'Apply change') + '</button></div>');
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
  try { useWorkspace(await call('pushToJira', { taskId, field, range: periodRange() })); $('modal').close(); render(); announce(field === 'assignee' ? 'Jira assignee updated.' : 'Jira due date updated.'); }
  catch (e) { modal('Jira was not updated', '<p>' + esc(e.message) + '</p><div class="actions"><button data-dismiss>Close</button></div>'); }
  finally { busy = false; }
}
let noticeTimer;
function announce(text) {
  $('notice').textContent = text || '';
  clearTimeout(noticeTimer);
  if (text) noticeTimer = setTimeout(() => { $('notice').textContent = ''; }, 6000);
}

$('modal').addEventListener('close', () => { draft = null; formValues = null; });
$('close').onclick = () => $('modal').close();
$('simulate').onclick = () => (role === 'member' ? (tab === 'schedule' ? changeForm({ kind: 'private', who: member }) : logForm()) : changeForm());
$('otherChanges').onclick = () => changeForm({ kind: 'leave', ...(role === 'member' ? { who: member } : {}) });
$('reset').onclick = () => modal('Reset sample plan?', '<p>This restores the original assignments and time off and removes the changes you applied to the demo.</p><div class="actions"><button data-dismiss>Cancel</button><button id="confirmReset" class="primary">Reset demo</button></div>');
$('settingsLink').onclick = () => { location.href = '../settings/'; };
$('refresh').onclick = async () => {
  $('refresh').disabled = true; announce('Reading Jira…');
  try { useWorkspace(await call('refresh', { range: periodRange() })); render(); announce('Refreshed from Jira.' + (state.unmapped.length ? ' ' + state.unmapped.length + ' issues need mapping in Relay settings.' : '')); }
  catch (e) { announce(''); modal('Jira refresh failed', '<p>' + esc(e.message) + '</p><div class="actions"><button data-dismiss>Close</button></div>'); }
  finally { $('refresh').disabled = false; }
};
for (const k of Object.keys(pageInfo)) $(k + 'Tab').onclick = () => { tab = k; announce(''); render(); };
document.addEventListener('change', e => {
  const id = e.target.id;
  if (id === 'filter') { filter = e.target.value; render(); }
  // Switching priority keeps what was entered; another kind of change starts a fresh form.
  if (id === 'field-kind') { const v = values(); delete v.name; changeForm(['urgent', 'queued'].includes(v.kind) ? v : { kind: v.kind }); }
  // Type, project or system changes recompute the suggested estimate.
  if (id === 'field-type') { const v = values(); delete v.name; changeForm(v); }
  if (id === 'field-p') { const v = values(); delete v.s; changeForm(v); }
  if (id === 'field-s') changeForm(values());
  if (id === 'personFilter') { personFilter = e.target.value; render(); }
  if (id === 'periodMode') {
    const mode = e.target.value;
    // Keep today in view when it is; otherwise centre on the middle of what was shown (so a week switches to the month it mostly falls in).
    const middle = isoAdd(period.from, Math.floor((Date.parse(period.to) - Date.parse(period.from)) / DAY / 2));
    if (mode === 'custom') { period = { ...period, mode }; render(); } else { setPeriod(mode, mode !== 'month' && inPeriod(anchorDay()) ? anchorDay() : middle); load(); }
  }
  if (id === 'pmCal') { pmCal = e.target.value; render(); }
  if (id === 'accuracyBy') { accuracyBy = e.target.value; render(); }
  if (id === 'teamPick') {
    session.team = e.target.value;
    try { sessionStorage.setItem('relay.team', session.team); } catch {}
    booted = false; tab = 'home'; personFilter = 'all'; filter = 'all'; announce(''); load();
  }
  if (id === 'pmProject') { pmProject = Number(e.target.value); announce(''); render(); }
});
// A click anywhere on a table row opens the item named in it (not while selecting text).
document.addEventListener('click', e => {
  if (e.target.closest('button,a,input,select,label') || String(getSelection())) return;
  e.target.closest('.data tbody tr')?.querySelector('button.link,button.project')?.click();
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
  if (b.dataset.shift) { shiftPeriod(Number(b.dataset.shift)); load(); }
  if (b.id === 'periodToday') { setPeriod(period.mode === 'custom' ? 'week' : period.mode, anchorDay()); load(); }
  if (b.id === 'periodApply') {
    const from = $('periodFrom').value, to = $('periodTo').value;
    if (!from || !to || to < from) return announce('Choose a start date before the end date.');
    if ((Date.parse(to) - Date.parse(from)) / DAY + 1 > MAX_DAYS) return announce('Choose a period of at most ' + MAX_DAYS + ' days.');
    period = { mode: 'custom', from, to }; load();
  }
  if (b.id === 'more') { showAll = !showAll; render(); }
  if (b.dataset.leaveStart !== undefined) {
    const w = Number(b.dataset.leaveWho), l = state.leave.find(l => l.who === w && l.start === Number(b.dataset.leaveStart));
    const ids = 'data-who="' + w + '" data-from="' + l.start + '"';
    const ask = requesting();
    modal('Time off', '<p class="note"><b>' + esc(who(w).name) + (l.reason ? ' · ' + esc(l.reason) : '') + '</b><br>' + leaveText(l) + '</p><p>Work is planned around this time. Moving or removing it reschedules the affected tasks' + (ask ? ', once the team manager approves.' : '.') + '</p><div class="actions"><button data-release-leave ' + ids + '>' + (ask ? 'Request removal' : 'Remove time off') + '</button><button class="primary" data-edit-leave ' + ids + '>' + (ask ? 'Request new dates' : 'Reschedule') + '</button></div>');
  }
  if (b.hasAttribute('data-edit-leave')) { const l = state.leave.find(l => l.who === Number(b.dataset.who) && l.start === Number(b.dataset.from)); changeForm({ kind: 'leave', who: l.who, from: l.start, start: l.start, len: l.len, reason: l.reason ?? '' }); }
  if (b.hasAttribute('data-release-leave')) {
    const who = Number(b.dataset.who), from = Number(b.dataset.from);
    requesting() ? send({ kind: 'requestLeave', v: { who, from, remove: true } }, 'Request sent. The team manager will approve or decline it.') : send({ kind: 'releaseLeave', who, start: from }, 'Time off removed.');
  }
  if (b.dataset.reviewRequest) reviewRequest(b.dataset.reviewRequest);
  for (const k of ['approve', 'decline', 'cancel']) if (b.dataset[k + 'Request']) send({ kind: k + 'Request', id: b.dataset[k + 'Request'] }, { approve: 'Time off approved.', decline: 'Request declined.', cancel: 'Request cancelled.' }[k]);
  if (b.id === 'undoLast') modal('Undo the last change?', '<p class="note">' + esc(undo) + '</p><p>The plan goes back to how it was before it. Anything already written to Jira (work logs, statuses, comments) stays as it is.</p><div class="actions"><button data-dismiss>Cancel</button><button class="primary" id="confirmUndo">Undo change</button></div>');
  if (b.id === 'confirmUndo') runUndo();
  if (b.id === 'rulesLink') modal('How planning works', rulesHtml(settings, timeInJira));
  if (b.id === 'apply' && draft) requesting() && formValues.kind === 'leave' ? send({ kind: 'requestLeave', v: formValues }, 'Request sent. The team manager will approve or decline it.') : send({ kind: 'draft', v: formValues, baseRev: state.rev });
  if (b.id === 'confirmReset') { tab = 'home'; personFilter = 'all'; filter = 'all'; showAll = false; booted = false; send({ kind: 'reset' }, 'Sample plan restored.'); }
});

function noteView(i) {
  const note = state.notes[i] || '';
  return '<h3>Shared project note</h3>' + (note ? '<p class="context-note">' + esc(note) + '</p>' : '') + '<button data-note="' + i + '">' + (note ? 'Edit note' : 'Add a note') + '</button>';
}
/** Calendar header for project managers: all their projects or one, and a way to add a task. */
function pmCalendarHeader() {
  const mine = me.pmProjects.filter(i => projects[i] && !projects[i].archived);
  if (!mine.length) return '<p class="empty">No projects are assigned to you yet. Ask a Jira administrator to add them in Relay settings.</p>';
  if (pmCal !== 'all' && !mine.includes(Number(pmCal))) pmCal = 'all';
  return '<div class="queue-tools"><label>Projects <select id="pmCal">' + options([['all', 'All my projects'], ...mine.map(i => [i, projects[i].name])], pmCal) + '</select></label><button id="addQueued">＋ Add task</button></div>' + board();
}
/** Project picker for project managers, shared by the outlook and calendar. */
function pmHeader() {
  const mine = me.pmProjects.filter(i => projects[i] && !projects[i].archived);
  if (!mine.length) return '<p class="empty">No projects are assigned to you yet. Ask a Jira administrator to add them in Relay settings.</p>';
  return '<div class="queue-tools"><label>Project <select id="pmProject">' + options(mine.map(i => [i, projects[i].name]), pmProject) + '</select></label><span class="sub">Contact · ' + esc(who(projects[pmProject]?.lead).name) + '</span></div>';
}
function pmView() {
  const p = projects[pmProject];
  if (!p) return '<p class="empty">No projects are assigned to you yet. Ask a Jira administrator to add them in Relay settings.</p>';
  const forecast = finish(state, plan, pmProject);
  const fixed = state.fixed.map(f => ({ f, t: state.tasks.find(t => t.id === f.taskId) })).filter(x => x.t?.p === pmProject);
  const blockers = state.tasks.filter(t => t.p === pmProject && t.wait?.shared).map(t => '<p class="wait-note">' + esc(t.wait.reason) + '</p>').join('');
  const dates = fixed.length ? fixed.map(({ f, t }) => '<div class="detail">' + esc(t.name) + ' · <b>' + fmt(f.start) + '</b>' + (!Number.isFinite(plan.get(t.id).end) ? ' · At risk' : '') + '</div>').join('') : '<p class="sub">No fixed starts recorded.</p>';
  const risk = !Number.isFinite(forecast) ? 'Awaiting input' : forecast > p.due ? 'Forecast runs late' : 'On track';
  const tone = !Number.isFinite(forecast) ? ' tone-waiting' : forecast > p.due ? ' tone-late' : '';
  const tasks = state.tasks.filter(t => t.p === pmProject);
  const logged = logsInPeriod().filter(e => e.p === pmProject);
  const header = pmHeader();
  const outlook = '<section class="focus-card' + tone + '"><div class="focus-label">' + risk + '</div><div class="focus-content"><small>' + esc(p.name) + ' milestone</small><h2>' + fmt(forecast) + '</h2><p>Requested by ' + dueText(p) + (Number.isFinite(forecast) && forecast > p.due ? ' · ' + daysLate(forecast, p.due) + ' workdays beyond target' : '') + '</p></div></section>';
  const effort = '<section class="panel summary-card"><div class="section-head"><h2>Project time</h2><small>' + periodLabel() + '</small></div><div class="time-large">' + hours(sumTime(logged)) + '</div><div class="sub">Recorded on ' + esc(p.name) + '</div><button class="link" data-page="report">Open project report →</button></section>';
  return header + '<div class="dash-pair">' + outlook + effort + '</div><section class="panel"><div class="section-head"><h2>Delivery details</h2><span class="sub">' + tasks.filter(t => t.actual != null).length + ' of ' + tasks.length + ' tasks completed</span></div><div class="content"><div class="effort-bar" aria-hidden="true"><span class="seg-work" style="width:' + (tasks.length ? 100 * tasks.filter(t => t.actual != null).length / tasks.length : 0) + '%"></span></div><h3>Fixed starts</h3>' + dates + (blockers ? '<h3>Help needed</h3>' + blockers : '') + noteView(pmProject) + '</div></section>' +
    tableBox('Tasks', ['Task', 'Owner', 'Forecast', 'State'], tasks.map(t => { const x = plan.get(t.id); return ['<button class="link" data-task="' + t.id + '">' + esc(t.name) + '</button><small class="meta-line">' + esc(systems[t.s]) + '</small>', esc(who(x.who).name), span(x.start, x.end - 1), pill(statusOf(t))]; }), 'No tasks planned for this project yet.');
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
  if (button.dataset.freeWho !== undefined) {
    const w = Number(button.dataset.freeWho), mine = role === 'pm' ? me.pmProjects : active(projects).map(([, i]) => i);
    const p = (role === 'pm' && pmCal !== 'all' ? Number(pmCal) : null) ?? mine.find(i => projects[i].lead === w || projects[i].back === w) ?? mine[0];
    changeForm({ kind: 'queued', p, start: button.dataset.freeStart, prefer: w, fit: button.dataset.freeHours });
  }
  if (button.id === 'addQueued') changeForm({ kind: 'queued', ...(role === 'pm' && pmCal !== 'all' ? { p: Number(pmCal) } : {}) });
  if (role === 'pm') return;
  for (const op of ['estimate', 'finish', 'revise', 'pause', 'resume']) if (button.dataset[op]) changeForm({ kind: op, taskId: button.dataset[op] });
  if (button.dataset.start) send({ kind: 'start', taskId: button.dataset.start });
  if (button.dataset.timing && role === 'team') changeForm({ kind: 'timing', taskId: button.dataset.timing });
  const id = button.dataset.private || button.dataset.editPrivate || button.dataset.releasePrivate || button.dataset.releaseSeries;
  if (!id) return;
  const b = state.privateTime.find(block => block.id === id);
  const mine = role === 'team' || b.who === member;
  if (button.dataset.private) modal('Private team time', '<p class="note"><b>' + esc(b.name) + '</b><br>' + esc(who(b.who).name) + ' · ' + span(b.start, b.start + b.len - 1) + '</p><p>This time belongs to the team. The PM sees project forecasts and customer coordination only.</p>' + (mine ? '<div class="actions">' + (b.series ? '<button data-release-series="' + id + '">Release this and later weeks</button>' : '') + '<button data-release-private="' + id + '">Release time</button><button class="primary" data-edit-private="' + id + '">Edit private block</button></div>' : ''));
  if (button.dataset.editPrivate) changeForm({ ...b, kind: 'private', blockId: id });
  if (button.dataset.releasePrivate) send({ kind: 'releasePrivate', id }, 'Private time released.');
  if (button.dataset.releaseSeries) send({ kind: 'releasePrivate', id, later: true }, 'Private time released from ' + fmt(b.start) + ' on.');
});

function hours(minutes) { const whole = Math.floor(minutes / 60), part = minutes % 60; return part ? (whole ? whole + 'h ' : '') + part + 'm' : whole + 'h'; }
function weekdayName(iso) { return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
function logsInPeriod() { return state.logs.filter(e => inPeriod(e.date)); }
function sumTime(entries) { return entries.reduce((n, e) => n + e.minutes, 0); }
function tableBox(title, headers, rows, empty, id = '', tools = '') {
  return '<section class="panel"' + (id ? ' id="' + id + '"' : '') + '><div class="section-head"><h2>' + title + '</h2>' + tools + '</div>' + (rows.length ? '<div class="scroll"><table class="data"><thead><tr>' + headers.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(v => '<td>' + v + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' : '<p class="empty">' + empty + '</p>') + '</section>';
}
/** Headline numbers: [label, value, tone ('bad' | 'warn' | ''), id of the section it jumps to]. */
function metrics(items) { return '<div class="metrics" style="--n:' + items.length + '">' + items.map(([label, value, tone = '', jump]) => (jump ? '<button data-jump="' + jump + '"' : '<div') + ' class="' + tone + '"><small>' + label + '</small><strong>' + value + '</strong>' + (jump ? '</button>' : '</div>')).join('') + '</div>'; }
/** Hours with a bar showing their share of the largest value in the table. */
function hoursBar(minutes, max, p) { return '<span class="hbar" style="--w:' + (max ? Math.round(100 * minutes / max) : 0) + '%;' + (p == null ? '' : color(p)) + '"><span>' + hours(minutes) + '</span><i></i></span>'; }
// Every entry is project work, internal work or time off taken (logged on the time-off issues).
const isOff = e => e.absence != null, isProject = e => e.p != null, isInternal = e => e.p == null && !isOff(e);
const offLabel = e => 'Time off' + (e.absence ? ' · ' + e.absence : '');
/** Headline numbers for a list of entries; time off only when there is some or it is recorded. */
const timeStats = (entries, total) => metrics([[total, hours(sumTime(entries))], ['Project work', hours(sumTime(entries.filter(isProject)))], ['Internal work', hours(sumTime(entries.filter(isInternal)))], ...(settings.general.absenceToJira || entries.some(isOff) ? [['Time off', hours(sumTime(entries.filter(isOff)))]] : [])]);
function projectTotals(entries) {
  const sums = new Map();
  for (const e of entries) { const k = isOff(e) ? 'off' : e.p; sums.set(k, (sums.get(k) || 0) + e.minutes); }
  const max = Math.max(0, ...sums.values());
  return [...sums].sort((a, b) => b[1] - a[1]).map(([p, n]) => [p === 'off' ? 'Time off' : p == null ? 'Internal work' : esc(projects[p]?.name ?? 'Archived project'), hoursBar(n, max, typeof p === 'number' ? p : null)]);
}
function memberHome() {
  const mine = state.tasks.filter(t => plan.get(t.id).who === member).sort((a, b) => a.rank - b.rank);
  const open = mine.filter(t => t.actual == null);
  const focus = open.find(t => t.started) || open.find(t => !startBlocker(t)) || open.find(t => t.wait);
  const entries = logsInPeriod().filter(e => e.who === member);
  let focusCard = '<p class="empty">No active or ready assignment. Review your upcoming work below.</p>';
  if (focus) {
    const x = plan.get(focus.id);
    focusCard = '<div class="focus-content"><small>' + esc(projects[focus.p].name) + ' / ' + esc(systems[focus.s]) + '</small><h2>' + esc(focus.name) + '</h2><p>' + (focus.wait ? esc(focus.wait.reason) : span(x.start, x.end - 1) + ' · ' + hrs(effectiveWork(focus)) + ' expected work · ' + hrs(duration(focus) - effectiveWork(focus)) + ' buffer') + '</p><button data-task="' + focus.id + '">Open task →</button></div>';
  }
  const rows = open.filter(t => t !== focus).map(t => [esc(projects[t.p].name), '<button class="link" data-task="' + t.id + '">' + esc(t.name) + '</button><small class="meta-line">' + esc(systems[t.s]) + '</small>', span(plan.get(t.id).start, plan.get(t.id).end - 1), pill(statusOf(t))]);
  return '<div class="dash-pair"><section class="focus-card' + (focus?.wait ? ' tone-waiting' : '') + '"><div class="focus-label">' + (focus?.started ? 'In progress' : focus?.wait ? 'Waiting' : 'Next assignment') + '</div>' + focusCard + '</section><section class="panel summary-card"><div class="section-head"><h2>My timesheet</h2><small>' + periodLabel() + '</small></div><div class="time-large">' + hours(sumTime(entries)) + '</div><div class="sub">Recorded in this period</div><button class="link" data-page="sheet">Open timesheet →</button></section></div>' + tableBox('My other assignments', ['Project', 'Task and system', 'Forecast', 'State'], rows, 'Your queue is clear.');
}
/** One entry per slot from `start`: 'work:<project>', 'buffer:<project>', protected, away, off or free. */
function loadSlots(start, count, person) {
  const end = start + count, slots = Array(count).fill('free');
  function put(a, b, k) { for (let i = Math.max(start, a); i < Math.min(b, end); i++) slots[i - start] = k; }
  for (const l of state.leave.filter(l => l.who === person)) put(l.start, l.start + l.len, 'away');
  for (const b of state.privateTime.filter(b => b.who === person)) put(b.start, b.start + b.len, 'protected');
  for (const t of state.tasks) {
    for (const h of t.history || []) if (h.who === person) put(h.start, h.end, 'work:' + t.p);
    const x = plan.get(t.id); if (x.who !== person) continue;
    if (Number.isFinite(x.start)) {
      const until = x.start + Math.max(1, effectiveWork(t) - spent(t));
      put(x.start, until, 'work:' + t.p); put(until, x.end, 'buffer:' + t.p);
    } else {
      const f = state.fixed.find(f => f.taskId === t.id);
      if (f && t.firstStart == null) put(f.start, f.start + duration(t), 'work:' + t.p);
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
  const [d0, d1] = periodDays(), nd = Math.max(0, d1 - d0 + 1), team = active(people), loads = team.map(([, i]) => loadSlots(d0 * spd, nd * spd, i));
  const waiting = state.tasks.filter(t => t.wait), late = projects.filter((p, i) => !p.archived && Number.isFinite(finish(state, plan, i)) && finish(state, plan, i) > p.due);
  const legend = { work: 'Project work', buffer: 'Buffer', protected: 'Private', away: 'Away', free: 'Open', off: 'Not working' };
  // Work and buffer cells name the project and use its calendar colour.
  const label = k => { const [kind, p] = k.split(':'); return p == null ? legend[kind] : (kind === 'buffer' ? 'Buffer · ' : '') + (projects[p]?.name ?? 'Project'); };
  const slotCell = k => { const [kind, p] = k.split(':'); return '<span class="load-cell ' + kind + (p != null ? ' proj" style="' + color(Number(p)) : '') + '" title="' + esc(label(k)) + '">' + esc(label(k)) + '</span>'; };
  const cell = day => day.every(k => k === day[0]) ? slotCell(day[0]) : '<span class="load-split">' + day.map(slotCell).join('') + '</span>';
  const capacity = '<section class="panel" id="capacity"><div class="section-head"><div><h2>Team capacity</h2><p>One cell per person per workday, split into ' + slotH + 'h slots when they differ.</p></div>' + periodPicker() + '</div><div class="scroll"><table class="data load-table"><thead><tr><th>Team member</th>' + Array.from({ length: nd }, (_, i) => '<th' + (d0 + i === todayDay() ? ' class="today"' : '') + '>' + fmt((d0 + i) * spd, { weekday: 'short', day: 'numeric' }) + '</th>').join('') + '</tr></thead><tbody>' + loads.map((slots, r) => '<tr><td>' + esc(team[r][0].name) + '</td>' + Array.from({ length: nd }, (_, d) => '<td>' + cell(slots.slice(d * spd, d * spd + spd)) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div></section>';
  const requests = state.leaveRequests ?? [];
  return (requests.length ? tableBox('Time-off requests', ['Who', 'Asks to', 'When', 'Reason', ''], requests.map(r => [esc(who(r.who).name), r.remove ? 'Remove time off' : r.from != null ? 'Move time off' : 'Take time off', leaveText(r), esc(r.reason || '—'), '<button data-review-request="' + r.id + '">Review</button>']), '', 'requests') : '') + metrics([['Open capacity', loads.flat().filter(k => k === 'free').length * slotH + 'h', '', 'capacity'], ['Tasks waiting now', waiting.length, waiting.length ? 'warn' : '', 'blockers'], ['Late milestone forecasts', late.length, late.length ? 'bad' : '', 'milestones']]) + capacity + tableBox('Blockers to review', ['Project', 'Task', 'Owner', 'Waiting for'], waiting.map(t => [esc(projects[t.p].name), '<button class="link" data-task="' + t.id + '">' + esc(t.name) + '</button>', esc(who(t.wait.who).name), esc(t.wait.reason)]), 'No waiting tasks.', 'blockers') + (differs.length ? tableBox('Jira assignee differs from the plan', ['Task', 'Planned for', 'Jira assignee'], differs.map(([t, x]) => ['<button class="link" data-task="' + t.id + '">' + esc((t.key ? t.key + ' ' : '') + t.name) + '</button>', esc(who(x.who).name), esc(t.assignee.name)]), '') : '') + milestones() +
    tableBox('Recent changes', ['When', 'Who', 'What'], (state.changes ?? []).slice(0, 8).map(c => [new Date(c.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), esc(c.by), esc(c.what)]), 'No changes yet.', 'changes', undo ? '<button id="undoLast" title="' + esc(undo) + '">↶ Undo last change</button>' : '');
}
/** Timesheet entries this role sees in the period. */
function visibleEntries() {
  return logsInPeriod().filter(e => (role === 'member' ? e.who === member : role === 'pm' ? e.p === pmProject : true));
}
const exportButton = () => '<button data-export>Export CSV</button>';
/** Download the visible entries as CSV for invoicing or payroll. */
function exportCsv() {
  // A leading = + - @ would make spreadsheets run the cell as a formula.
  const cell = v => '"' + String(v ?? '').replace(/^[=+\-@]/, "'$&").replace(/"/g, '""') + '"';
  const rows = [['Date', 'Person', 'Project', 'Work', 'Hours', 'Comment'], ...visibleEntries().sort((a, b) => a.date.localeCompare(b.date)).map(e => {
    const t = state.tasks.find(t => t.id === e.task);
    return [e.date, people[e.who]?.name ?? '', isOff(e) ? 'Time off' : e.p != null ? projects[e.p]?.name ?? '' : 'Internal work', t ? t.name : isOff(e) ? e.absence || 'Time off' : e.label ?? '', (e.minutes / 60).toFixed(2), e.note ?? ''];
  })];
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' })), download: 'timesheet-' + period.from + '_' + period.to + '.csv' });
  a.click();
  URL.revokeObjectURL(a.href);
}
function timesheetView() {
  const entries = logsInPeriod().filter(e => e.who === member).sort((a, b) => a.date.localeCompare(b.date));
  const pending = timeOffToRecord(entries);
  const toRecord = pending.length ? tableBox('Time off to record', ['Date', 'Time off', 'Hours', ''], pending.map(x => [weekdayName(x.date), esc(x.reason || 'Time off'), hours(x.minutes), '<button data-record-off="' + esc(JSON.stringify(x)) + '">Record</button>']), '', 'toRecord', pending.length > 1 ? '<button class="primary" data-record-all>Record all</button>' : '') : '';
  return '<div class="report-bar">' + periodPicker() + exportButton() + '</div>' + timeStats(entries, 'Total recorded') + toRecord + tableBox('Time entries', ['Date', 'Work', 'Duration', timeInJira ? 'Comment' : 'Personal note', ''], entries.map(e => {
    const t = state.tasks.find(t => t.id === e.task);
    return [weekdayName(e.date), t ? esc(projects[t.p].name) + '<small class="meta-line">' + esc(t.name) + '</small>' : isOff(e) ? esc(offLabel(e)) : e.label ? esc(e.label) : 'Internal work', hours(e.minutes), esc(e.note || '—'), '<button data-entry="' + esc(e.id) + '">Edit</button>'];
  }), timeInJira ? 'No time logged in Jira in this period. Use Log time to add a work log.' : 'No time recorded in this period. Use Log time to add an entry.');
}
const periodLength = () => Math.round((Date.parse(period.to) - Date.parse(period.from)) / DAY) + 1;
/** The period split into days (up to two weeks) or weeks (longer): [label, first ISO date, last ISO date]. */
function periodBuckets(entries = []) {
  const days = periodLength();
  // Weekend days only get a column when time was logged on them.
  if (days <= 14) return Array.from({ length: days }, (_, i) => isoAdd(period.from, i)).filter(iso => weekday(iso) % 6 !== 0 || entries.some(e => e.date === iso)).map(iso => [weekdayName(iso), iso, iso]);
  const out = [];
  for (let from = period.from; from <= period.to;) {
    const to = [isoAdd(from, 6 - (weekday(from) + 6) % 7), period.to].sort()[0];
    out.push(['Week of ' + weekdayName(from).replace(/^\w+ /, ''), from, to]);
    from = isoAdd(to, 1);
  }
  return out;
}
const byDay = () => periodLength() <= 14;
/** Total time per day or week of the period. */
function dailyRows(entries) {
  return periodBuckets(entries).map(([label, from, to]) => [label, hours(sumTime(entries.filter(e => e.date >= from && e.date <= to)))]);
}
function reportView() {
  const pm = role === 'pm', personal = role === 'member', entries = visibleEntries();
  const bar = '<div class="report-bar">' + periodPicker() + exportButton() + (pm ? '<label>Project <select id="pmProject">' + options(me.pmProjects.filter(i => projects[i]).map(i => [i, projects[i].name]), pmProject) + '</select></label>' : '') + '</div>';
  if (pm) {
    const bySystem = systems.map((system, i) => [system, sumTime(entries.filter(e => state.tasks.find(t => t.id === e.task)?.s === i))]).filter(([, n]) => n > 0).map(([system, n], _, all) => [esc(system), hoursBar(n, Math.max(...all.map(x => x[1])), pmProject)]);
    const current = finish(state, plan, pmProject), p = projects[pmProject];
    if (!p) return bar + '<p class="empty">No projects are assigned to you yet.</p>';
    return bar + metrics([['Project hours', hours(sumTime(entries))], ['Current milestone forecast', fmt(current)], ['Requested milestone', dueText(p)]]) + tableBox('Time by system', ['System', 'Recorded time'], bySystem, 'No project hours recorded in this period.') + tableBox('Project time by ' + (byDay() ? 'day' : 'week'), [byDay() ? 'Date' : 'Week', 'Logged project time'], dailyRows(entries), '') + '<button data-page="outlook">Open project outlook →</button>';
  }
  const stats = timeStats(entries, 'Recorded hours');
  const groups = tableBox('Time by project', ['Project or category', 'Recorded time'], projectTotals(entries), 'No entries for this period.');
  if (personal) return bar + stats + groups + tableBox('Time by ' + (byDay() ? 'day' : 'week'), [byDay() ? 'Date' : 'Week', 'Recorded time'], dailyRows(entries), '');
  const perPerson = active(people).map(([p, i]) => [p, entries.filter(e => e.who === i)]), most = Math.max(0, ...perPerson.map(([, mine]) => sumTime(mine)));
  const withOff = settings.general.absenceToJira || entries.some(isOff);
  return bar + stats + tableBox('Team time summary', ['Member', 'Project work', 'Internal work', ...(withOff ? ['Time off'] : []), 'Total'], perPerson.map(([p, mine]) => [esc(p.name), hours(sumTime(mine.filter(isProject))), hours(sumTime(mine.filter(isInternal))), ...(withOff ? [hours(sumTime(mine.filter(isOff)))] : []), hoursBar(sumTime(mine), most)]), '') + groups + teamOverTime(entries) + accuracy();
}
/** Estimated against actual hours of tasks finished in Relay (the history window), grouped by type, system or person. */
function accuracy() {
  const done = state.completed.filter(c => c.est > 0), name = { type: c => types[c.type]?.name, system: c => systems[c.s], person: c => people[c.who]?.name }[accuracyBy];
  const groups = new Map();
  for (const c of done) { const k = name(c) ?? '—', g = groups.get(k) ?? { n: 0, est: 0, act: 0 }; g.n++; g.est += c.est; g.act += c.hours; groups.set(k, g); }
  const rows = [...groups].sort((a, b) => b[1].n - a[1].n).map(([k, g]) => {
    const diff = Math.round(100 * (g.act - g.est) / g.est);
    return [esc(k), g.n, Math.round(g.est) + 'h', Math.round(g.act) + 'h', pill(Math.abs(diff) <= 10 ? 'On estimate' : diff > 0 ? diff + '% over' : -diff + '% under', diff > 10 ? 'late' : 'on-track')];
  });
  const tools = '<label class="sub">Group by <select id="accuracyBy">' + options([['type', 'Task type'], ['system', 'System'], ['person', 'Person']], accuracyBy) + '</select></label>';
  return tableBox('Estimate accuracy', [{ type: 'Task type', system: 'System', person: 'Person' }[accuracyBy], 'Finished tasks', 'Estimated', 'Actual', 'Difference'], rows, 'No finished tasks to compare yet. Recording a finish compares the actual hours with the estimate.', 'accuracy', tools) + '<p class="sub">Tasks finished in Relay in the last ' + settings.general.historyMonths + ' months. Within 10% counts as on estimate.</p>';
}
/** Team report: each person's hours per day or week of the period, with totals. */
function teamOverTime(entries) {
  const buckets = periodBuckets(entries), team = active(people);
  const sum = (list, [, from, to]) => sumTime(list.filter(e => e.date >= from && e.date <= to));
  const rows = team.map(([p, i]) => { const mine = entries.filter(e => e.who === i); return [esc(p.name), ...buckets.map(b => (sum(mine, b) ? hours(sum(mine, b)) : '—')), '<b>' + hours(sumTime(mine)) + '</b>']; });
  rows.push(['<b>Team</b>', ...buckets.map(b => '<b>' + hours(sum(entries, b)) + '</b>'), '<b>' + hours(sumTime(entries)) + '</b>']);
  return tableBox('Time by ' + (byDay() ? 'day' : 'week'), ['Member', ...buckets.map(([label]) => label), 'Total'], rows, '');
}
function logForm(existing, taskId) {
  if (role !== 'member' || (existing && existing.who !== member)) return;
  const e = existing ? { ...existing, task: isOff(existing) ? 'absence:' + existing.absence : existing.task } : { task: taskId || '', date: inPeriod(today) ? today : period.from, minutes: 60, note: '' };
  const internal = settings.general.internalIssue, g = settings.general;
  const choices = [
    ...(!timeInJira ? [['', 'Internal work']] : internal ? [['', 'Internal work (' + internal + ')']] : []),
    ...(g.absenceToJira ? ['', ...LEAVE_REASONS].filter(r => !timeInJira || absenceIssue(g, r)).map(r => ['absence:' + r, 'Time off · ' + (r || 'no reason') + (timeInJira ? ' (' + absenceIssue(g, r) + ')' : '')]) : []),
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
  const entry = { id: old?.id ?? (timeInJira ? undefined : crypto.randomUUID()), issue: old?.issue, prevTask: old ? (isOff(old) ? 'absence:' + old.absence : old.task ?? '') : undefined, prevDate: old?.date, task: data.get('entryTask') || '', date: dateValue, minutes, note: data.get('note') };
  const ok = await send({ kind: 'log', entry }, (timeInJira ? 'Logged in Jira · ' : 'Time saved · ') + hours(minutes) + ' on ' + weekdayName(dateValue) + '.');
  if (ok) { if (!inPeriod(dateValue)) setPeriod(period.mode === 'custom' ? 'week' : period.mode, dateValue); load(); }
});
document.addEventListener('click', event => {
  const b = event.target.closest('button'); if (!b) return;
  if (b.dataset.page) { tab = b.dataset.page; render(); }
  if (b.dataset.jump) document.getElementById(b.dataset.jump)?.scrollIntoView();
  if (b.hasAttribute('data-export')) exportCsv();
  if (b.dataset.push) pushToJira(b.dataset.pushTask, b.dataset.push);
  if (role !== 'member') return;
  if (b.dataset.recordOff) recordTimeOff([JSON.parse(b.dataset.recordOff)]);
  if (b.hasAttribute('data-record-all')) recordTimeOff(timeOffToRecord(logsInPeriod().filter(e => e.who === member)));
  if (b.dataset.logTask) logForm(null, b.dataset.logTask);
  if (b.dataset.entry) logForm(state.logs.find(e => e.id === b.dataset.entry));
  if (b.dataset.removeLog) modal('Delete time entry?', '<p>This removes the recorded hours from your timesheet and the reports.</p><div class="actions"><button data-dismiss>Cancel</button><button class="primary" data-delete-log="' + esc(b.dataset.removeLog) + '">Delete entry</button></div>');
  if (b.dataset.deleteLog) { const old = state.logs.find(x => x.id === b.dataset.deleteLog); send({ kind: 'deleteLog', id: old?.id, issue: old?.issue, date: old?.date }, 'Time entry deleted.'); }
});

/** Days of the member's time off up to today, in the period, with no time-off entry yet: { date, minutes, reason }. */
function timeOffToRecord(entries) {
  if (!settings.general.absenceToJira) return [];
  const out = [], perDay = people[member]?.hoursPerDay ?? settings.general.workdayHours;
  for (const l of state.leave.filter(l => l.who === member)) {
    const days = new Map(); // workday → slots away that the person works
    for (let s = l.start; s < l.start + l.len; s++) if (!off(member, s)) days.set(Math.floor(s / spd), (days.get(Math.floor(s / spd)) ?? 0) + 1);
    for (const [d, n] of days) {
      const date = M.cal.isoOfDay(d);
      if (inPeriod(date) && date <= today && !entries.some(e => e.date === date && isOff(e))) out.push({ date, minutes: Math.min(n * slotH, perDay) * 60, reason: l.reason ?? '' });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
/** Log each day of time off as the member's own entry (a Jira work log on its time-off issue in live mode). */
async function recordTimeOff(list) {
  let done = 0;
  for (const x of list) {
    if (!(await send({ kind: 'log', entry: { id: timeInJira ? undefined : crypto.randomUUID(), task: 'absence:' + x.reason, date: x.date, minutes: x.minutes, note: '' } }, ''))) break;
    done++;
  }
  await load();
  if (done) announce('Recorded ' + done + ' day' + (done === 1 ? '' : 's') + ' of time off' + (timeInJira ? ' in Jira.' : '.'));
}

/** Members asking for time off: it counts only after the team manager approves. */
const requesting = () => role === 'member' && leaveMode(settings.general) === 'request';
/** A member's pending time-off requests, above their calendar. */
function myRequests() {
  const mine = role === 'member' ? (state.leaveRequests ?? []).filter(r => r.who === member) : [];
  return mine.length ? '<div class="requests">' + mine.map(r => '<div class="detail request-row"><div><b>' + (r.remove ? 'Remove time off' : r.from != null ? 'Move time off' : esc(r.reason || 'Time off')) + ' · ' + leaveText(r) + '</b><small>Request waiting for the team manager</small></div><button data-cancel-request="' + r.id + '">Cancel request</button></div>').join('') + '</div>' : '';
}
/** Team manager: what approving a time-off request would move, then approve or decline. */
function reviewRequest(id) {
  const r = state.leaveRequests.find(x => x.id === id);
  if (!r) return;
  let impact = 'Approving frees this time for planning.';
  if (!r.remove) {
    try { const n = M.makeDraft(state, plan, { kind: 'leave', who: r.who, start: r.start, len: r.len, reason: r.reason, from: r.from }).moved.length; impact = n + (n === 1 ? ' assignment moves' : ' assignments move') + ' if you approve.'; }
    catch (e) { impact = 'This request can no longer be approved: ' + e.message; }
  }
  modal('Time-off request', '<p class="note"><b>' + esc(who(r.who).name) + ' · ' + (r.remove ? 'Remove time off' : r.from != null ? 'Move time off' : esc(r.reason || 'Time off')) + '</b><br>' + leaveText(r) + (r.from != null && !r.remove ? '<br><small>Currently from ' + fmt(r.from) + '</small>' : '') + '</p><p>' + esc(impact) + '</p><div class="actions"><button data-dismiss>Later</button><button data-decline-request="' + r.id + '">Decline</button><button class="primary" data-approve-request="' + r.id + '">Approve</button></div>');
}
async function runUndo() {
  if (busy) return;
  busy = true;
  try { useWorkspace(await call('undo', { demo: demoCtx(), range: periodRange() })); $('modal').close(); render(); announce('Change undone.'); }
  catch (e) { if (e.code === 'stale') await load(); modal('Nothing was undone', '<p>' + esc(e.message) + '</p><div class="actions"><button data-dismiss>Close</button></div>'); }
  finally { busy = false; }
}
// Drag and drop on the team calendar: dropping a task on a day in someone's row previews a fixed start there.
document.addEventListener('dragstart', e => {
  const id = e.target.closest?.('[data-drag]')?.dataset.drag;
  if (id) { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; }
});
const clearDrop = () => document.querySelectorAll('.drop-here').forEach(x => x.classList.remove('drop-here'));
document.addEventListener('dragover', e => {
  const lane = role === 'team' && e.target.closest?.('.lane[data-who]');
  if (!lane) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  if (!lane.classList.contains('drop-here')) { clearDrop(); lane.classList.add('drop-here'); }
});
document.addEventListener('dragend', clearDrop);
document.addEventListener('drop', e => {
  const lane = e.target.closest?.('.lane[data-who]'), id = e.dataTransfer.getData('text/plain');
  clearDrop();
  if (role !== 'team' || !lane || !state.tasks.some(t => t.id === id)) return;
  e.preventDefault();
  const r = lane.getBoundingClientRect(), slot = Number(lane.dataset.start) + Math.floor((e.clientX - r.left) / r.width * Number(lane.dataset.cols)), day = Math.floor(slot / spd);
  if (day * spd + spd <= M.now) return announce('Drop the task on today or a later day.');
  try { preview({ kind: 'timing', taskId: id, stamp: M.cal.isoOfDay(day), prefer: lane.dataset.who }); }
  catch (err) { modal('Task not moved', '<p>' + esc(err.message) + '</p><div class="actions"><button data-dismiss>Close</button></div>'); }
});

load();
