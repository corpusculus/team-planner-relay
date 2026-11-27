// Planning model shared by the browser (previews) and the Forge backend (authoritative apply).
// Time is counted in slots: settings.general.slotHours each, workdayHours/slotHours per workday, Mon–Fri.
import { toSlots, multiplier } from './estimate.js';

export const DAY_MS = 86400000;
export class UserError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/** Reasons a person can give for time off. Only the team manager and the person themselves see them. */
export const LEAVE_REASONS = ['Vacation', 'Sick leave', 'Personal', 'Training', 'Other'];
/** A timesheet entry's work is a task id, '' for internal work, or 'absence:<reason>' for time off taken. */
export const absenceOf = task => (String(task ?? '').startsWith('absence:') ? String(task).slice(8) : null);
/** The Jira issue that time off with this reason is logged on, or '' when none is set. */
export const absenceIssue = (general, reason) => (general.absenceToJira ? general.absenceIssues?.[reason || 'none'] || general.absenceIssues?.none || '' : '');
/** Who changes a member's time off: 'off' (team manager only), 'request' (member asks, manager approves) or 'free'. Older settings stored true/false. */
export const leaveMode = general => (general.memberLeave === true ? 'free' : ['request', 'free'].includes(general.memberLeave) ? general.memberLeave : 'off');

export function calendar(general) {
  const spd = general.workdayHours / general.slotHours, epoch = Date.parse(general.planStart + 'T00:00:00Z');
  // Workday index of an ISO date. Weekends map to Friday, or to the next Monday when up=true.
  const dayIndex = (iso, up = false) => {
    const e = Math.round((Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z') - epoch) / DAY_MS), w = Math.floor(e / 7), wd = e - w * 7;
    return wd > 4 ? (up ? (w + 1) * 5 : w * 5 + 4) : w * 5 + wd;
  };
  const dateOf = d => new Date(epoch + (Math.floor(d / 5) * 7 + ((d % 5) + 5) % 5) * DAY_MS);
  const isWeekday = iso => new Date(String(iso).slice(0, 10) + 'T00:00:00Z').getUTCDay() % 6 !== 0;
  return { spd, epoch, dayIndex, dateOf, isWeekday, isoOfDay: d => dateOf(d).toISOString().slice(0, 10) };
}

export function emptyState(settings) {
  return { rev: 0, unit: unitOf(settings), tasks: [], leave: [], privateTime: [], fixed: [], leaveRequests: [], notes: {}, logs: [], logMonths: [], completed: [], unmapped: [], ops: [], changes: [] };
}
const unitOf = settings => ({ slotHours: settings.general.slotHours, workdayHours: settings.general.workdayHours });

/** Fill missing fields and convert slot positions/durations if the slot size or workday length changed. */
export function normalize(state, settings) {
  const s = { ...emptyState(settings), ...structuredClone(state) };
  for (const t of s.tasks) if (!Array.isArray(t.deps)) { t.deps = t.after ? [t.after] : []; delete t.after; }
  const from = s.unit, to = unitOf(settings);
  if (from.slotHours !== to.slotHours || from.workdayHours !== to.workdayHours) {
    const fromSpd = from.workdayHours / from.slotHours, toSpd = to.workdayHours / to.slotHours;
    const pos = x => x == null || !Number.isFinite(x) ? x : Math.floor(x / fromSpd) * toSpd + Math.min(toSpd - 1, Math.floor((x % fromSpd) * from.slotHours / to.slotHours));
    const len = x => x == null ? x : Math.max(1, toSlots(x * from.slotHours, to.slotHours));
    for (const t of s.tasks) {
      t.ready = pos(t.ready); t.firstStart = pos(t.firstStart); t.work = len(t.work);
      t.buffer = t.buffer ? toSlots(t.buffer * from.slotHours, to.slotHours) : 0;
      t.revised = len(t.revised); t.actual = len(t.actual);
      if (t.started) t.started.start = pos(t.started.start);
      for (const h of t.history || []) { const n = len(h.end - h.start); h.start = pos(h.start); h.end = h.start + n; }
    }
    for (const b of [...s.leave, ...s.privateTime, ...s.leaveRequests]) { b.start = pos(b.start); b.len = len(b.len); if (b.from != null) b.from = pos(b.from); }
    for (const f of s.fixed) f.start = pos(f.start);
    for (const t of s.tasks) for (const k of ['firstStart', 'revised', 'actual']) if (t[k] == null) delete t[k];
    s.unit = to;
  }
  return s;
}

/**
 * Add, edit or delete one of the caller's time entries. `logs` holds the months the entry is in (and was in).
 * New entries arrive with a client-made id so a retried request is applied once.
 */
export function applyLogOp(logs, op, me, tasks) {
  if (op.kind === 'deleteLog') return logs.filter(x => x.id !== op.id || x.who !== me.person);
  const e = op.entry || {}, minutes = Number(e.minutes), date = String(e.date || ''), id = String(e.id || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new UserError('Choose a date.');
  if (!Number.isInteger(minutes) || minutes <= 0) throw new UserError('Enter a positive duration.');
  if (!/^[\w-]{8,64}$/.test(id)) throw new UserError('This time entry is not valid. Reload and try again.');
  const existing = logs.find(x => x.id === id);
  if (existing && existing.who !== me.person) throw new UserError('You can only edit your own time entries.');
  const sameDay = logs.filter(x => x.id !== id && x.who === me.person && x.date === date).reduce((n, x) => n + x.minutes, 0);
  if (sameDay + minutes > 1440) throw new UserError('Daily entries can total up to 24 hours.');
  const absence = absenceOf(e.task);
  if (absence != null && absence !== '' && !LEAVE_REASONS.includes(absence)) throw new UserError('Choose a kind of time off.');
  const t = e.task && absence == null ? tasks.find(t => t.id === e.task) : null;
  if (e.task && absence == null && !t) throw new UserError('This task is no longer in the plan.');
  const entry = { id, who: me.person, task: t?.id ?? null, p: t?.p ?? null, date, minutes, note: String(e.note ?? '').trim().slice(0, 400), ...(absence != null ? { absence } : {}) };
  return logs.filter(x => x.id !== id).concat(entry);
}

export function createModel(settings, todayIso) {
  const g = settings.general, slotH = g.slotHours, cal = calendar(g), spd = cal.spd, weekSlots = 5 * spd;
  const systems = settings.systems, types = settings.types;
  const people = settings.people.map(p => ({
    ...p,
    short: p.name.split(/\s+/)[0],
    initials: p.name.split(/\s+/).map(x => x[0] || '').join('').slice(0, 2).toUpperCase()
  }));
  const skillsOf = w => (w == null || !people[w] || people[w].archived ? [] : people[w].skills);
  const projects = settings.projects.map(p => ({
    ...p,
    due: p.due ? cal.dayIndex(p.due) * spd + spd - 1 : Infinity,
    systems: [...new Set([...skillsOf(p.lead), ...skillsOf(p.back)])]
  }));
  const now = Math.max(0, cal.dayIndex(todayIso, true) * spd);
  const holidays = new Set((settings.holidays ?? []).filter(cal.isWeekday).map(iso => cal.dayIndex(iso)));
  const isHoliday = slot => holidays.has(Math.floor(slot / spd));
  /** True when person w does not work in this slot: public holiday, a weekday they don't work, or past their hours that day. */
  function off(w, slot) {
    const d = Math.floor(slot / spd), p = people[w];
    return holidays.has(d) || !(p?.days ?? [0, 1, 2, 3, 4]).includes(((d % 5) + 5) % 5) || slot - d * spd >= Math.ceil((p?.hoursPerDay ?? g.workdayHours) / slotH);
  }
  /** The first n slots person w works, from `start` on. */
  function take(w, start, n) {
    const out = [];
    for (let s = start; out.length < n; s++) {
      if (s - start > 50 * weekSlots) throw new UserError(who(w).short + ' has no working time. Check their working days and hours in Relay settings.');
      if (!off(w, s)) out.push(s);
    }
    return out;
  }

  const fmt = (s, opts = { day: 'numeric', month: 'short' }) =>
    Number.isFinite(s) ? cal.dateOf(Math.floor(s / spd)).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' }) : 'Pending';
  const span = (a, b) => (!Number.isFinite(a) || !Number.isFinite(b) ? 'Pending' : Math.floor(a / spd) === Math.floor(b / spd) ? fmt(a) : fmt(a) + ' – ' + fmt(b));
  const clock = s => (spd > 1 ? ' ' + String(g.dayStartHour + (s % spd) * slotH).padStart(2, '0') + ':00' : '');
  const slotLabel = s => fmt(s, { weekday: 'short', month: 'short', day: 'numeric' }) + (Number.isFinite(s) ? clock(s) : '');
  const hrs = n => n * slotH + 'h';
  /** Dates of a time-off entry or request, with its length: '3 Dec – 4 Dec · 2 workdays' or '3 Dec · 4h'. */
  const leaveText = l => span(l.start, l.start + l.len - 1) + ' · ' + (l.len % spd ? hrs(l.len) : l.len / spd + ' workday' + (l.len === spd ? '' : 's'));
  const daysLate = (d, due) => Math.ceil((d - due) / spd);
  const dueText = p => (Number.isFinite(p.due) ? fmt(p.due) : 'No date');

  const effectiveWork = t => t.actual ?? t.revised ?? t.work;
  const duration = t => t.actual ?? Math.max(t.work + (t.buffer || 0), effectiveWork(t));
  const spent = t => (t.history || []).reduce((n, h) => n + h.end - h.start, 0);
  const remaining = t => Math.max(1, duration(t) - spent(t));
  const statusOf = t => (t.actual != null ? 'Done' : t.wait ? 'Waiting' : t.started ? 'In progress' : 'Queued');
  const who = w => people[w] ?? { name: 'Unassigned', short: 'Unassigned', initials: '–', role: '' };

  function eligible(t) {
    const p = projects[t.p];
    if (!p) return [];
    const list = [...new Set([p.lead, p.back])].filter(w => w != null && people[w] && !people[w].archived && people[w].skills.includes(t.s));
    if (t.prefer != null && list.includes(t.prefer)) list.sort((a, b) => (b === t.prefer) - (a === t.prefer));
    return list;
  }

  function schedule(state) {
    const occupied = people.map(() => new Set()), slots = new Map();
    for (const l of state.leave) for (let d = l.start; d < l.start + l.len; d++) occupied[l.who]?.add(d);
    for (const block of state.privateTime) {
      for (let d = block.start; d < block.start + block.len; d++) {
        if (occupied[block.who].has(d)) throw new UserError(who(block.who).short + ' already has time reserved on ' + fmt(d) + '. Move the private block or choose another date.');
        occupied[block.who].add(d);
      }
    }
    const reservations = new Map(), availableFrom = people.map(() => 0);
    for (const t of state.tasks) for (const h of t.history || []) {
      for (let day = h.start; day < h.end; day++) {
        if (occupied[h.who].has(day)) throw new UserError('This change overlaps recorded work on ' + fmt(day) + '.');
        occupied[h.who].add(day);
      }
      availableFrom[h.who] = Math.max(availableFrom[h.who], h.end);
    }
    for (const t of state.tasks.filter(t => t.started)) {
      const { who: w, start } = t.started, work = take(w, start, remaining(t)), end = work.at(-1) + 1;
      for (const d of work) {
        if (occupied[w].has(d)) throw new UserError(who(w).short + ' has a conflict on ' + fmt(d) + ' with ' + t.name + '. Check the recorded work or availability.');
        occupied[w].add(d);
      }
      reservations.set(t.id, { who: w, start, end });
      availableFrom[w] = Math.max(availableFrom[w], end);
    }
    for (const fixed of state.fixed) {
      const task = state.tasks.find(t => t.id === fixed.taskId);
      if (!task) continue;
      if (task.firstStart != null) {
        if (task.firstStart !== fixed.start) throw new UserError('The agreed start conflicts with the first recorded start.');
        continue;
      }
      if (task.started) {
        if (task.started.start !== fixed.start) throw new UserError('The fixed date conflicts with a recorded start.');
        continue;
      }
      const contacts = eligible(task);
      if (contacts.includes(fixed.preferred)) contacts.sort((a, b) => Number(b === fixed.preferred) - Number(a === fixed.preferred));
      const w = contacts.find(c => fixed.start >= availableFrom[c] && !off(c, fixed.start) && take(c, fixed.start, duration(task)).every(d => !occupied[c].has(d)));
      if (w === undefined) throw new UserError('No qualified contact is available for ' + projects[task.p].name + ' · ' + task.name + ' on its fixed start date, ' + fmt(fixed.start) + '.');
      const days = take(w, fixed.start, duration(task));
      for (const day of days) occupied[w].add(day);
      reservations.set(task.id, { who: w, start: fixed.start, end: days.at(-1) + 1 });
    }
    const ids = new Set(state.tasks.map(t => t.id)), deps = t => (t.deps ?? []).filter(id => ids.has(id));
    const queue = state.tasks.slice().sort((a, b) => a.rank - b.rank);
    while (queue.length) {
      const i = queue.findIndex(t => deps(t).every(id => slots.has(id)));
      if (i < 0) throw new UserError('These tasks depend on each other in a loop: ' + queue.map(t => t.name).slice(0, 3).join(', ') + '.');
      const [t] = queue.splice(i, 1);
      const prereq = Math.max(t.ready, ...deps(t).map(id => slots.get(id).end));
      if (t.wait || !Number.isFinite(prereq)) {
        slots.set(t.id, { who: t.wait?.who ?? reservations.get(t.id)?.who ?? eligible(t)[0], start: Infinity, end: Infinity });
        continue;
      }
      const hold = reservations.get(t.id);
      if (hold) {
        if (prereq > hold.start) throw new UserError('The prerequisite for ' + projects[t.p].name + ' would finish after its fixed start date on ' + fmt(hold.start) + '. Adjust the proposed change.');
        slots.set(t.id, { who: hold.who, start: hold.start, end: hold.end });
        continue;
      }
      const ready = Math.max(prereq, now);
      let best = null;
      for (const w of eligible(t)) {
        let work = take(w, Math.max(ready, availableFrom[w]), remaining(t)), clash;
        while ((clash = work.find(d => occupied[w].has(d))) !== undefined) work = take(w, clash + 1, remaining(t));
        // Earliest finish wins, so a part-time contact does not get work a full-time one would finish sooner.
        if (!best || work.at(-1) < best.work.at(-1)) best = { who: w, work };
      }
      if (!best) throw new UserError('No qualified contact for ' + (projects[t.p]?.name ?? 'an archived project') + ' · ' + t.name + '. Check project contacts and skills in Relay settings.');
      slots.set(t.id, { who: best.who, start: best.work[0], end: best.work.at(-1) + 1 });
      for (const d of best.work) occupied[best.who].add(d);
    }
    return slots;
  }

  function finish(st, pl, p) { return Math.max(...st.tasks.filter(t => t.p === p).map(t => pl.get(t.id).end - 1)); }

  function startBlocker(state, plan, t) {
    const x = plan.get(t.id);
    if (t.wait) return 'Resolve the blocker to return this task to the queue.';
    if (state.tasks.some(a => (t.deps ?? []).includes(a.id) && a.actual == null)) return 'Complete the prerequisites first.';
    if (state.tasks.some(a => a.id !== t.id && plan.get(a.id).who === x.who && a.actual == null && (a.started || plan.get(a.id).start < x.start))) return 'An earlier assignment for ' + who(x.who).short + ' is still open.';
    return '';
  }

  // --- input parsing for changes (this is the trust boundary for client-sent forms) ---
  const slotsOf = (h, min = 0) => {
    const n = Number(h);
    if (!Number.isFinite(n) || n < 0 || n > 8760) throw new UserError('Enter hours between 0 and 8760.');
    const s = toSlots(n, slotH);
    if (s < min) throw new UserError('Enter at least ' + min * slotH + ' hours.');
    return s;
  };
  const slotIdx = x => {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw new UserError('Choose a valid date.');
    return n;
  };
  const personIdx = x => {
    const n = Number(x);
    if (!people[n] || people[n].archived) throw new UserError('Choose a team member.');
    return n;
  };
  const text = (x, max) => String(x ?? '').trim().slice(0, max);

  function makeDraft(state, plan, v) {
    const next = structuredClone(state);
    let summary = '';
    const task = id => {
      const t = next.tasks.find(t => t.id === id);
      if (!t) throw new UserError('This task is no longer in the plan.');
      return t;
    };
    if (v.kind === 'pause') {
      const t = task(v.taskId), x = plan.get(t.id), used = slotsOf(v.used), reason = text(v.reason, 200);
      if (!t.started || t.actual != null || !reason || used > x.end - x.start) throw new UserError('Enter the blocker and the hours already spent in this assignment.');
      t.firstStart ??= x.start;
      t.history ??= [];
      if (used) t.history.push({ who: x.who, start: x.start, end: x.start + used });
      t.ready = x.start + used;
      t.wait = { who: x.who, reason, shared: !!v.shareReason };
      delete t.started;
      t.revised = Math.max(effectiveWork(t), spent(t) + 1);
      summary = t.name + ' · Waiting for ' + t.wait.reason;
    } else if (v.kind === 'resume') {
      const t = task(v.taskId);
      if (!t.wait) throw new UserError('This task is not waiting.');
      t.ready = Math.max(t.ready, slotIdx(v.resumeDay));
      delete t.wait;
      summary = t.name + ' · Back in queue from ' + fmt(t.ready);
    } else if (v.kind === 'timing') {
      const t = task(v.taskId);
      next.fixed = next.fixed.filter(f => f.taskId !== t.id);
      summary = projects[t.p].name + ' · ' + t.name + ' · Flexible start';
      if (v.stamp) {
        const elapsed = (Date.parse(v.stamp + 'T00:00:00Z') - cal.epoch) / DAY_MS;
        if (!Number.isInteger(elapsed) || elapsed < 0 || elapsed % 7 > 4) throw new UserError('Choose a weekday on or after ' + g.planStart + '.');
        const start = (Math.floor(elapsed / 7) * 5 + (elapsed % 7)) * spd;
        const preferred = v.prefer != null && v.prefer !== '' ? Number(v.prefer) : plan.get(t.id).who;
        if (v.prefer != null && v.prefer !== '' && !eligible(t).includes(preferred)) throw new UserError(who(preferred).short + ' does not cover ' + systems[t.s] + ' on ' + projects[t.p].name + '.');
        next.fixed.push({ taskId: t.id, start, preferred });
        summary = projects[t.p].name + ' · ' + t.name + ' · Fixed start ' + fmt(start) + (v.prefer != null && v.prefer !== '' ? ' · ' + who(preferred).name : '');
      }
    } else if (['estimate', 'finish', 'revise'].includes(v.kind)) {
      const t = task(v.taskId), n = slotsOf(v.hours, 1);
      if (n <= spent(t)) throw new UserError('Total effort must include the recorded work and at least one more slot.');
      if (v.kind === 'estimate') { t.work = n; t.buffer = slotsOf(v.buffer); t.manual = true; t.source = 'Edited in Relay'; delete t.revised; }
      if (v.kind === 'revise') t.revised = n;
      if (v.kind === 'finish') {
        if (!t.started) throw new UserError('Start the task before recording its finish.');
        t.actual = n;
        if (t.type != null) next.completed.push({ id: t.id, type: t.type, p: t.p, s: t.s, hours: n * slotH, mult: multiplier(settings, t.p, t.s, t.labels).value, at: todayIso, source: 'relay', est: t.work * slotH, who: t.started.who });
      }
      summary = projects[t.p].name + ' · ' + t.name + ' · ' + (v.kind === 'finish' ? 'Finished in ' + hrs(n) : hrs(effectiveWork(t)) + ' expected + ' + hrs(duration(t) - effectiveWork(t)) + ' buffer');
    } else if (v.kind === 'urgent' || v.kind === 'queued') {
      const p = Number(v.p), s = Number(v.s), type = Number(v.type), name = text(v.name, 70);
      if (!projects[p] || projects[p].archived) throw new UserError('Choose a project.');
      if (!types[type]) throw new UserError('Choose a task type.');
      if (!projects[p].systems.includes(s)) throw new UserError('Nobody on ' + projects[p].name + ' covers that system.');
      if (!name) throw new UserError('Enter a task name.');
      const ranks = next.tasks.map(t => t.rank);
      const t = {
        id: 'u' + crypto.randomUUID().slice(0, 8), p, s, type, name,
        work: slotsOf(v.hours, 1), buffer: slotsOf(v.buffer), source: text(v.source, 120) || 'Entered in Relay',
        rank: v.kind === 'urgent' ? (ranks.length ? Math.min(...ranks) : 0) - 1 : (ranks.length ? Math.max(...ranks) : 0) + 1,
        deps: [], ready: slotIdx(v.start), ...(v.prefer != null && v.prefer !== '' && people[Number(v.prefer)] ? { prefer: Number(v.prefer) } : {})
      };
      next.tasks.push(t);
      summary = projects[p].name + ' · ' + name;
    } else if (v.kind === 'private') {
      const name = text(v.name, 70), len = slotsOf(v.hours, 1);
      if (!name) throw new UserError('Enter a private work label.');
      const old = v.blockId ? next.privateTime.find(b => b.id === v.blockId) : null;
      if (v.blockId && !old) throw new UserError('This private block no longer exists.');
      const weeks = old ? 1 : Number(v.repeat || 1);
      if (!Number.isInteger(weeks) || weeks < 1 || weeks > 26) throw new UserError('Repeat for 1 to 26 weeks.');
      // Repeated blocks share a series id, so the later ones can be released together.
      const w = personIdx(v.who), start = slotIdx(v.start), series = weeks > 1 ? 's' + crypto.randomUUID().slice(0, 8) : old?.series;
      const blocks = Array.from({ length: weeks }, (_, k) => ({ id: (!k && old?.id) || 'f' + crypto.randomUUID(), who: w, start: start + k * weekSlots, len, name, ...(series ? { series } : {}) }));
      next.privateTime = next.privateTime.filter(b => b.id !== old?.id).concat(blocks);
      summary = who(w).name + ' · Protected time · ' + span(start, start + len - 1) + (weeks > 1 ? ' · every week for ' + weeks + ' weeks' : '');
    } else if (v.kind === 'leave') {
      // Length in slots (`len`, so part of a day works); older clients send whole `days`.
      const w = personIdx(v.who), start = slotIdx(v.start), len = v.len != null && v.len !== '' ? Number(v.len) : Number(v.days) * spd;
      if (!Number.isInteger(len) || len < 1 || len > 60 * spd) throw new UserError('Choose up to 60 days away.');
      const reason = LEAVE_REASONS.includes(v.reason) ? v.reason : '';
      // `from` is the start of an existing entry being rescheduled: it is replaced instead of added to.
      const moving = v.from != null && v.from !== '';
      if (moving) {
        const at = next.leave.findIndex(x => x.who === w && x.start === Number(v.from));
        if (at < 0) throw new UserError('This time off no longer exists.');
        next.leave.splice(at, 1);
      }
      const existing = next.leave.filter(x => x.who === w);
      if (Array.from({ length: len }, (_, k) => start + k).every(d => existing.some(l => l.start <= d && l.start + l.len > d))) throw new UserError('This person is already away for those dates.');
      next.leave.push({ who: w, start, len, ...(reason ? { reason } : {}) });
      summary = who(w).name + (moving ? ' · Time off moved to ' : ' · ' + (reason || 'Time off') + ' · ') + leaveText({ start, len });
    } else if (v.kind === 'extend') {
      const t = task(v.taskId);
      if (t.actual != null) throw new UserError('This task is already finished.');
      t.revised = effectiveWork(t) + slotsOf(v.hours, 1);
      summary = projects[t.p].name + ' · ' + t.name + ' now needs ' + hrs(effectiveWork(t)) + ' with ' + hrs(duration(t) - effectiveWork(t)) + ' buffer remaining';
    } else throw new UserError('Unknown change.');
    const slots = schedule(next), moved = state.tasks.filter(t => {
      const a = plan.get(t.id), b = slots.get(t.id);
      return b && (a.start !== b.start || a.end !== b.end || a.who !== b.who);
    });
    return { next, slots, moved, summary };
  }

  /** Remove one time-off entry (a person's entries are told apart by their start) and return it. */
  function dropLeave(next, w, start) {
    const at = next.leave.findIndex(x => x.who === w && x.start === start);
    if (at < 0) throw new UserError('This time off no longer exists.');
    return next.leave.splice(at, 1)[0];
  }

  /** Apply any change to the plan. Returns { next, message, summary }; throws UserError when invalid. */
  function applyOp(state, op, me) {
    const plan = schedule(state);
    let next = structuredClone(state), message, summary;
    if (op.kind === 'draft') {
      ({ next, summary } = makeDraft(state, plan, op.v || {}));
      message = 'Change applied. The schedule and milestone forecasts are updated.';
    } else if (op.kind === 'start') {
      const t = state.tasks.find(t => t.id === op.taskId);
      if (!t || t.started || t.actual != null || startBlocker(state, plan, t)) throw new UserError('This task cannot start yet.');
      const x = plan.get(t.id);
      next.tasks.find(a => a.id === t.id).started = { who: x.who, start: x.start };
      message = 'Started ' + t.name + ' on ' + fmt(x.start) + '.';
    } else if (op.kind === 'releasePrivate') {
      const b = state.privateTime.find(x => x.id === op.id);
      if (!b) throw new UserError('This private block no longer exists.');
      // `later`: this block and the later ones of its weekly series.
      next.privateTime = next.privateTime.filter(x => (op.later && b.series ? !(x.series === b.series && x.start >= b.start) : x.id !== b.id));
      message = 'Private time released' + (op.later && b.series ? ' from ' + fmt(b.start) + ' on.' : '.');
    } else if (op.kind === 'releaseLeave') {
      const gone = dropLeave(next, Number(op.who), Number(op.start));
      message = who(gone.who).name + ' · Time off removed · ' + leaveText(gone);
    } else if (op.kind === 'requestLeave') {
      // A member asks for new, moved or removed time off; nothing changes until the team manager approves.
      const v = op.v || {}, w = personIdx(v.who), from = v.from != null && v.from !== '' ? Number(v.from) : null;
      let req;
      if (v.remove) {
        const l = state.leave.find(x => x.who === w && x.start === from);
        if (!l) throw new UserError('This time off no longer exists.');
        req = { who: w, from, remove: true, start: l.start, len: l.len, reason: l.reason ?? '' };
      } else {
        const added = makeDraft(state, plan, { ...v, kind: 'leave' }).next.leave.at(-1); // validates dates and the existing entry
        req = { who: w, from, start: added.start, len: added.len, reason: added.reason ?? '' };
      }
      // A newer request for the same entry replaces the older one.
      next.leaveRequests = next.leaveRequests.filter(r => from == null || r.who !== w || r.from !== from).concat({ id: 'r' + crypto.randomUUID().slice(0, 8), at: todayIso, ...req });
      message = 'Request sent. The team manager will approve or decline it.';
      summary = who(w).name + ' requested ' + (req.remove ? 'removing time off · ' : from != null ? 'moving time off to ' : (req.reason || 'time off') + ' · ') + leaveText(req);
    } else if (['approveRequest', 'declineRequest', 'cancelRequest'].includes(op.kind)) {
      const r = state.leaveRequests.find(x => x.id === op.id);
      if (!r) throw new UserError('This request was already handled.');
      const rest = next.leaveRequests.filter(x => x.id !== r.id);
      if (op.kind === 'approveRequest') {
        if (r.remove) dropLeave(next, r.who, r.from);
        else next = makeDraft(state, plan, { kind: 'leave', who: r.who, start: r.start, len: r.len, reason: r.reason, from: r.from }).next;
      }
      next.leaveRequests = rest;
      message = who(r.who).name + ' · ' + (r.remove ? 'Removing time off' : 'Time off') + ' ' + leaveText(r) + ' · ' + { approveRequest: 'approved', declineRequest: 'declined', cancelRequest: 'request cancelled' }[op.kind];
    } else if (op.kind === 'note') {
      const p = Number(op.p);
      if (!projects[p]) throw new UserError('Choose a project.');
      next.notes[p] = text(op.text, 800);
      message = 'Shared project note saved.';
    } else throw new UserError('Unknown change.');
    schedule(next);
    return { next, message, summary: summary ?? message };
  }

  return {
    settings, people, projects, systems, types, cal, spd, slotH, weekSlots, now,
    fmt, span, slotLabel, hrs, leaveText, daysLate, dueText, who,
    effectiveWork, duration, spent, remaining, statusOf, eligible, schedule, finish, startBlocker, makeDraft, applyOp, off, isHoliday, take
  };
}
