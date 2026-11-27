// Monthly capacity: each person's working hours per month against planned work, other Jira work and monthly support loads.
// Counted in hours per calendar month, from today on: a planning summary over months, next to the slot-level plan.

/** Hours of standing monthly load are measured over this many complete months of logged time. */
export const LOAD_MONTHS = 3;

/** One entry per slot from `start`: 'work:<project>', 'buffer:<project>', 'protected', 'away', 'off' or 'free'. */
export function slotKinds(M, state, plan, person, start, count) {
  const end = start + count, slots = Array(count).fill('free');
  const put = (a, b, k) => { for (let i = Math.max(start, a); i < Math.min(b, end); i++) slots[i - start] = k; };
  for (const l of state.leave.filter(l => l.who === person)) put(l.start, l.start + l.len, 'away');
  for (const b of state.privateTime.filter(b => b.who === person)) put(b.start, b.start + b.len, 'protected');
  for (const t of state.tasks) {
    for (const h of t.history || []) if (h.who === person) put(h.start, h.end, 'work:' + t.p);
    const x = plan.get(t.id);
    if (x?.who !== person) continue;
    if (Number.isFinite(x.start)) {
      const until = x.start + Math.max(1, M.effectiveWork(t) - M.spent(t));
      put(x.start, until, 'work:' + t.p); put(until, x.end, 'buffer:' + t.p);
    } else {
      const f = state.fixed.find(f => f.taskId === t.id);
      if (f && t.firstStart == null) put(f.start, f.start + M.duration(t), 'work:' + t.p);
    }
  }
  return slots.map((k, i) => (M.off(person, start + i) ? 'off' : k));
}

/** Health of a month at this utilization (%). The target utilization is the top of healthy. */
export const health = (pct, net, target) => (!net ? 'No capacity' : pct > 100 ? 'Over' : pct > target ? 'Stretched' : pct >= 50 ? 'Healthy' : 'Underused');

const iso = d => d.toISOString().slice(0, 10);
/** The month of `day` and the n − 1 after it: { key: 'YYYY-MM', label, from, to }. */
export function monthsFrom(day, n) {
  const [y, m] = day.split('-').map(Number);
  return Array.from({ length: n }, (_, k) => {
    const a = new Date(Date.UTC(y, m - 1 + k, 1));
    return { key: iso(a).slice(0, 7), label: a.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }), from: iso(a), to: iso(new Date(Date.UTC(y, m + k, 0))) };
  });
}
/** The `n` complete months before the month of `day`: { from, to }. */
export const pastMonths = (day, n = LOAD_MONTHS) => {
  const [y, m] = day.split('-').map(Number);
  return { from: iso(new Date(Date.UTC(y, m - 1 - n, 1))), to: iso(new Date(Date.UTC(y, m - 1, 0))) };
};

/** A project's standing monthly load in hours and where the number comes from; null when it has none. */
export function monthlyLoad(settings, history, p) {
  const proj = settings.projects[p];
  if (!proj || proj.archived || !['auto', 'fixed'].includes(proj.load)) return null;
  if (proj.load === 'fixed') return { hours: Number(proj.loadHours) || 0, source: 'Fixed' };
  const logged = history?.hours?.[p] ?? 0;
  if (logged > 0) return { hours: logged / (history.months || LOAD_MONTHS), source: 'Logged, last ' + LOAD_MONTHS + ' months', logged };
  return { hours: settings.general.loadDefault ?? 40, source: history ? 'Default, nothing logged' : 'Default, not measured yet', logged: history ? 0 : null };
}

/**
 * Person × month capacity for the next `n` months (the current one from today on):
 * gross working hours, absence (time off, public holidays), net, and what fills it — planned Relay work with buffers,
 * private time, other Jira work assigned to them, and monthly support loads. Loads go to the project lead, then the backup,
 * each up to the target utilization; what neither can take is the uncovered gap.
 */
export function capacity(M, state, plan, today, n) {
  const g = M.settings.general, target = g.targetUtilization ?? 85, h = M.slotH, cal = M.cal, months = monthsFrom(today, n);
  const weekdays = (a, b) => Math.max(0, cal.dayIndex(b) - cal.dayIndex(a, true) + 1);
  const ranges = months.map(m => [Math.max(M.now, cal.dayIndex(m.from, true) * M.spd), (cal.dayIndex(m.to) + 1) * M.spd]);
  const zero = () => ({ gross: 0, absence: 0, planned: 0, private: 0, other: 0, support: 0 });

  const rows = M.people.map((p, w) => ({ p, w })).filter(x => !x.p.archived).map(({ p, w }) => ({
    w, name: p.name,
    months: ranges.map(([a, b]) => {
      const c = zero();
      if (b > a) slotKinds(M, state, plan, w, a, b - a).forEach((k, i) => {
        if (M.off(w, a + i, false)) return; // not one of their working slots
        c.gross += h;
        const kind = k.split(':')[0];
        if (kind === 'off' || kind === 'away') c.absence += h; // 'off' on a working slot is a public holiday
        else if (kind === 'work' || kind === 'buffer') c.planned += h;
        else if (kind === 'protected') c.private += h;
      });
      return c;
    })
  }));
  const byWho = new Map(rows.map(r => [r.w, r]));
  const used = c => c.planned + c.private + c.other + c.support;

  // Other Jira work: remaining hours spread over the weekdays from today (or the plan start) to its due date.
  // Without a due date it is provisional and spread over the horizon; overdue work counts on the first day.
  const end = months.at(-1).to, from = cal.isoOfDay(Math.floor(M.now / M.spd));
  const external = (state.external ?? []).map(e => {
    const overdue = !!e.to && e.to < from, to = overdue ? from : e.to || end, total = weekdays(from, to);
    const share = months.map(m => (!total ? (from >= m.from && from <= m.to ? e.hours : 0) : (e.hours * weekdays(from > m.from ? from : m.from, to < m.to ? to : m.to)) / total));
    share.forEach((x, k) => { const r = byWho.get(e.who); if (r) r.months[k].other += x; });
    return { ...e, provisional: !e.to, overdue, months: share };
  });

  const loads = M.projects.map((proj, p) => ({ proj, p, load: monthlyLoad(M.settings, state.loadHistory, p) })).filter(x => x.load).map(({ proj, p, load }) => ({
    p, name: proj.name, lead: proj.lead, back: proj.back, ...load,
    months: ranges.map(([a, b], k) => {
      // The current month only has the weekdays from today on.
      const demand = b > a ? load.hours * ((b - a) / M.spd) / (weekdays(months[k].from, months[k].to) || 1) : 0;
      let left = demand;
      const give = w => {
        const c = w == null ? null : byWho.get(w)?.months[k];
        const x = c ? Math.min(left, Math.max(0, (target / 100) * (c.gross - c.absence) - used(c))) : 0;
        if (x > 0) { c.support += x; left -= x; }
        return x;
      };
      const lead = give(proj.lead), back = proj.back === proj.lead ? 0 : give(proj.back);
      return { demand, lead, back, gap: left };
    })
  }));

  for (const r of rows) for (const c of r.months) {
    c.net = c.gross - c.absence; c.total = used(c);
    c.pct = c.net ? (100 * c.total) / c.net : 0;
    c.remaining = Math.max(0, c.net - c.total); c.over = Math.max(0, c.total - c.net);
    c.health = health(c.pct, c.net, target);
  }
  const totals = months.map((_, k) => ({
    net: rows.reduce((s, r) => s + r.months[k].net, 0),
    demand: rows.reduce((s, r) => s + r.months[k].planned + r.months[k].private + r.months[k].other, 0) + loads.reduce((s, l) => s + l.months[k].demand, 0),
    gap: loads.reduce((s, l) => s + l.months[k].gap, 0)
  }));
  const n0 = state.externalNoEstimate ?? 0;
  const notes = n0 ? [{ tone: 'info', text: n0 + ' other Jira issue' + (n0 === 1 ? ' has' : 's have') + ' no estimate and count as 0h.' }] : [];
  return { months, target, rows, loads, external, totals, insights: [...insights(M, months, rows, loads, external, totals, target), ...notes] };
}

const round = x => Math.round(x * 10) / 10;
/** Plain-language findings, most pressing first: { tone: 'bad' | 'warn' | 'info', text }. */
function insights(M, months, rows, loads, external, totals, target) {
  const out = [];
  totals.forEach((t, k) => { if (t.demand > t.net) out.push({ tone: 'bad', text: months[k].label + ': ' + round(t.demand - t.net) + 'h more needed than available.' }); });
  for (const r of rows) {
    const over = r.months.map((c, k) => [c, k]).filter(([c]) => c.health === 'Over');
    if (over.length) out.push({ tone: 'bad', text: r.name + ' is over 100% in ' + over.map(([, k]) => months[k].label).join(', ') + '.' });
  }
  for (const l of loads) {
    const gap = l.months.reduce((s, m) => s + m.gap, 0);
    if (gap < 0.05) continue;
    const owner = l.lead == null || M.people[l.lead]?.archived ? ', and it has no lead' : '';
    // Who could take it: someone else with a skill this project needs (any skill when it has no contacts) and room up to the target.
    const needs = M.projects[l.p]?.systems ?? [];
    const room = r => r.months.reduce((s, c) => s + Math.max(0, (target / 100) * c.net - c.total), 0);
    const fit = rows.filter(r => r.w !== l.lead && r.w !== l.back && (!needs.length || needs.some(s => M.people[r.w].skills.includes(s))) && room(r) >= 1)
      .sort((a, b) => room(b) - room(a))[0];
    out.push({ tone: 'warn', text: l.name + ': ' + round(gap) + 'h not covered' + owner + '.' + (fit ? ' ' + fit.name + ' has ' + round(room(fit)) + 'h free' + (needs.length ? ' and covers ' + needs.filter(s => M.people[fit.w].skills.includes(s)).map(s => M.systems[s]).join(', ') : '') + '.' : '') });
  }
  const provisional = external.filter(e => e.provisional);
  if (provisional.length) out.push({ tone: 'info', text: round(provisional.reduce((s, e) => s + e.hours, 0)) + 'h of other Jira work has no due date, so it is spread over these months.' });
  const overdue = external.filter(e => e.overdue);
  if (overdue.length) out.push({ tone: 'info', text: overdue.length + ' other Jira issue' + (overdue.length === 1 ? ' is' : 's are') + ' overdue and count from today.' });
  for (const r of rows) {
    const low = r.months.filter(c => c.health === 'Underused').length;
    if (low === months.length && months.length > 1) out.push({ tone: 'info', text: r.name + ' is under 50% every month.' });
  }
  return out;
}
