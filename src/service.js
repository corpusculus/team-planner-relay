// Relay backend logic. Storage and Jira are injected so the same code runs in Forge and in the local preview.
// Storage keys: 'settings', 'plan' (tasks and planning records), 'plan-rev:N' (short-lived save claims),
// 'logs:YYYY-MM' (demo timesheets only — in live mode time is logged as Jira work logs).
import { createModel, normalize, emptyState, applyLogOp, UserError, DAY_MS } from './shared/model.js';
import { sampleSettings, sampleState, liveSettings } from './shared/defaults.js';
import { validateSettings } from './shared/validate.js';
import { mapIssues, historyFromIssues, mergeTasks, issueFields } from './shared/jira-map.js';

const MEMBER_OPS = new Set(['start', 'log', 'deleteLog', 'releasePrivate', 'draft']);
const MEMBER_DRAFTS = new Set(['private', 'pause', 'resume', 'estimate', 'finish', 'revise']);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const monthOf = iso => String(iso).slice(0, 7);
const utcToday = () => new Date().toISOString().slice(0, 10);
const isoPlus = (iso, days) => new Date(Date.parse(iso + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);

/** The caller's local date when it is within a day of the server's UTC date (time zones), else the UTC date. */
export function pickDay(client, server) {
  return ISO.test(client ?? '') && Math.abs(Date.parse(client) - Date.parse(server)) <= DAY_MS ? client : server;
}

/** Monday–Sunday around a date. */
export function weekOf(iso) {
  const monday = isoPlus(iso, -((new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7));
  return { from: monday, to: isoPlus(monday, 6) };
}

/** Plain text of a Jira rich-text (ADF) comment, and back. */
const adfText = node => (!node ? '' : typeof node === 'string' ? node : node.type === 'text' ? node.text ?? '' : (node.content ?? []).map(adfText).join(node.type === 'doc' ? '\n' : ''));
const adf = text => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

/** What a caller may not see of a task: its Jira title, key, assignee and blocker text. */
const hideTask = (t, name) => ({ ...t, name, key: undefined, labels: [], source: '', assignee: null, wait: t.wait ? { who: t.wait.who, reason: '', shared: false } : undefined });

const logChange = (plan, by, what) => { plan.changes = [{ at: new Date().toISOString(), by, what }, ...(plan.changes ?? [])].slice(0, 100); };

export function createService({ store, jira, today = utcToday }) {
  // ---- demo timesheets (Relay storage) ----
  const readLogs = async months => (await Promise.all(months.map(m => store.get('logs:' + m)))).flatMap(list => list ?? []);
  /** Replace the given months (and any month the entries fall in) with these entries, and remember the months. */
  async function writeLogs(plan, logs, months = []) {
    const byMonth = Object.fromEntries(months.map(m => [m, []]));
    for (const e of logs) (byMonth[monthOf(e.date)] ??= []).push(e);
    await Promise.all(Object.entries(byMonth).map(([m, list]) => store.set('logs:' + m, list)));
    plan.logMonths = [...new Set([...(plan.logMonths ?? []), ...Object.keys(byMonth)])].sort();
  }

  /**
   * Persist the plan. Timesheet entries never stay inside it, and history older than the window is dropped.
   * With a base revision, only one of two saves made from the same revision succeeds; the other must reload.
   */
  async function savePlan(next, settings, day, baseRev) {
    const { logs = [], ...plan } = next;
    if (logs.length) await writeLogs(plan, logs);
    const cutoff = Date.parse(day) - settings.general.historyMonths * 30.44 * DAY_MS;
    plan.completed = (plan.completed ?? []).filter(c => Date.parse(c.at) >= cutoff);
    if (baseRev !== undefined) {
      plan.rev = baseRev + 1;
      if (!(await store.claim('plan-rev:' + plan.rev))) throw new UserError('Someone else saved the plan at the same moment. Reload and try again.', 'stale');
    }
    await store.set('plan', plan);
    return plan;
  }

  async function load(day = today()) {
    const settings = (await store.get('settings')) ?? sampleSettings();
    let raw = await store.get('plan');
    // First use, or plans saved before timesheets moved to their own keys.
    if (!raw || raw.logs?.length) raw = await savePlan(raw ?? (settings.demo ? sampleState(settings) : emptyState(settings)), settings, day);
    const { logs, ...plan } = raw;
    return { settings, state: normalize(plan, settings) };
  }

  /** Who is calling. In demo mode the caller picks a preview role; in live mode it comes from settings. */
  function identify(settings, accountId, demo) {
    if (settings.demo) {
      const access = ['member', 'team', 'pm'].includes(demo?.role) ? demo.role : 'team';
      const person = Number.isInteger(demo?.member) && settings.people[demo.member] ? demo.member : 0;
      return { access, person, pmProjects: settings.projects.map((_, i) => i), demo: true, name: 'Demo ' + { team: 'team manager', member: 'member', pm: 'project manager' }[access] };
    }
    const person = settings.people.findIndex(p => p.accountId === accountId && !p.archived);
    if (person < 0) return null;
    const p = settings.people[person];
    return { access: p.access, person, pmProjects: p.access === 'pm' ? p.pmProjects : [], demo: false, name: p.name };
  }

  // ---- timesheets: Jira work logs in live mode ----
  const liveTime = settings => !settings.demo && !!jira;

  /** Work logged in Jira by team members in the range, on connected projects and the internal-work issue. */
  async function jiraWorklogs(settings, state, range) {
    const keys = settings.projects.filter(p => p.jiraKey && !p.archived).map(p => '"' + p.jiraKey + '"'), internal = settings.general.internalIssue;
    if (!keys.length && !internal) return [];
    const scope = [keys.length && 'project in (' + keys.join(',') + ')', internal && 'key = "' + internal + '"'].filter(Boolean).join(' OR ');
    const issues = await searchAll('(' + scope + ') AND worklogDate >= "' + range.from + '" AND worklogDate <= "' + range.to + '"', ['project', 'summary'], 500);
    const project = new Map(settings.projects.map((p, i) => [p.jiraKey, i])), person = new Map(settings.people.map((p, i) => [p.accountId, i]));
    const tasks = new Set(state.tasks.map(t => t.id)), after = Date.parse(range.from) - DAY_MS, before = Date.parse(range.to) + 2 * DAY_MS, out = [];
    // shortcut: one request per issue with time in the range, 8 at a time; fine for one team, use /worklog/updated for large sites.
    for (let i = 0; i < issues.length; i += 8) await Promise.all(issues.slice(i, i + 8).map(async issue => {
      const isInternal = issue.key === internal;
      for (const w of await jira.worklogs(issue.id, after, before)) {
        const who = person.get(w.author?.accountId), date = String(w.started).slice(0, 10);
        if (who === undefined || date < range.from || date > range.to) continue;
        out.push({
          id: String(w.id), issue: String(issue.id), who, date, minutes: Math.round(w.timeSpentSeconds / 60), note: adfText(w.comment).trim(),
          task: !isInternal && tasks.has('jira-' + issue.id) ? 'jira-' + issue.id : null,
          p: isInternal ? null : project.get(issue.fields?.project?.key) ?? null,
          label: isInternal ? 'Internal work' : issue.key + ' · ' + (issue.fields?.summary ?? '')
        });
      }
    }));
    return out;
  }

  /** Add, change or delete a Jira work log as the caller. Returns the date the entry is now on. */
  async function writeWorklog(settings, state, op) {
    if (op.kind === 'deleteLog') {
      if (!/^\d+$/.test(String(op.issue)) || !/^\d+$/.test(String(op.id))) throw new UserError('This time entry is not valid. Reload and try again.');
      await jira.deleteWorklog(String(op.issue), String(op.id));
      return op.date;
    }
    const e = op.entry ?? {}, minutes = Number(e.minutes), date = String(e.date ?? ''), note = String(e.note ?? '').trim().slice(0, 400);
    if (!ISO.test(date)) throw new UserError('Choose a date.');
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) throw new UserError('Enter a duration of up to 24 hours.');
    const task = e.task ? state.tasks.find(t => t.id === e.task && t.key) : null;
    const issue = e.task ? task?.key : settings.general.internalIssue;
    if (!issue) throw new UserError(e.task ? 'Time can only be logged on Jira issues.' : 'Ask an admin to set an internal-work issue in Relay settings.');
    // Noon UTC keeps the work log on the chosen day in every time zone a team is likely to be in.
    const body = { timeSpentSeconds: minutes * 60, started: date + 'T12:00:00.000+0000', ...(note ? { comment: adf(note) } : {}) };
    const sameIssue = String(e.task ?? '') === String(e.prevTask ?? '');
    // shortcut: Jira has no idempotency key, so a retried request can add a work log twice; the entry is visible and editable.
    if (e.id && e.issue && sameIssue) await jira.updateWorklog(String(e.issue), String(e.id), body);
    else {
      await jira.addWorklog(issue, body);
      if (e.id && e.issue) await jira.deleteWorklog(String(e.issue), String(e.id)); // moved to another issue
    }
    return date;
  }

  /** Timesheet entries in a date range: Jira work logs in live mode, Relay storage in the demo. */
  async function timesheets(settings, state, range) {
    if (liveTime(settings)) return jiraWorklogs(settings, state, range);
    const months = [...new Set([monthOf(range.from), monthOf(range.to)])];
    return (await readLogs(months.filter(m => state.logMonths.includes(m)))).filter(e => e.date >= range.from && e.date <= range.to);
  }

  /**
   * Remove what the caller's role must not see. Demo data is fictional and returned whole so roles can be previewed.
   * Issues were read from Jira with the team manager's access, so other roles only get titles they are entitled to.
   */
  async function redact(state, me, model) {
    if (me.demo) return state;
    const s = structuredClone(state);
    s.ops = [];
    s.privateTime = s.privateTime.map(b => (me.access === 'member' && b.who === me.person ? b : { ...b, name: 'Private time' }));
    if (me.access === 'team') s.logs = s.logs.map(e => ({ ...e, note: '' }));
    if (me.access !== 'team') s.changes = [];
    if (me.access === 'member') {
      const plan = model.schedule(state);
      const mine = t => plan.get(t.id)?.who === me.person || t.wait?.who === me.person || t.history?.some(h => h.who === me.person);
      s.tasks = s.tasks.map(t => (mine(t) ? t : hideTask(t, 'Team work')));
      s.logs = s.logs.filter(e => e.who === me.person);
      s.completed = [];
      s.unmapped = [];
    }
    if (me.access === 'pm') {
      const mine = new Set(me.pmProjects);
      const ids = s.tasks.filter(t => mine.has(t.p) && t.key).map(t => t.id.slice('jira-'.length));
      const allowed = jira && ids.length ? await jira.canBrowse(ids) : null;
      s.tasks = s.tasks.map(t => {
        if (!mine.has(t.p)) return hideTask(t, 'Other team work');
        if (allowed && t.key && !allowed.has(t.id.slice('jira-'.length))) return hideTask(t, 'Restricted issue');
        return t.wait && !t.wait.shared ? { ...t, wait: { ...t.wait, reason: 'Waiting' } } : t;
      });
      s.logs = s.logs.filter(e => mine.has(e.p)).map(e => ({ ...e, note: '', who: -1, label: '' }));
      s.notes = Object.fromEntries(Object.entries(s.notes).filter(([p]) => mine.has(Number(p))));
      s.completed = [];
      s.unmapped = [];
    }
    return s;
  }

  /** A date range of at most six weeks, defaulting to the week of `day`. */
  function rangeFor(range, day) {
    if (!range) return weekOf(day);
    const { from, to } = range;
    if (!ISO.test(from) || !ISO.test(to) || to < from || Date.parse(to) - Date.parse(from) > 42 * DAY_MS) throw new UserError('Choose a valid period.');
    return { from, to };
  }

  /** Workspace with the timesheet entries of the requested period. */
  async function workspace(ctx, demo, range) {
    const { settings, state } = await load(ctx.today);
    const me = identify(settings, ctx.accountId, demo);
    if (!me) return { notMember: true, isAdmin: await ctx.isAdmin() };
    const period = rangeFor(range, ctx.today);
    state.logs = await timesheets(settings, state, period);
    return { settings, state: await redact(state, me, createModel(settings, ctx.today)), me, today: ctx.today, range: period, timeInJira: liveTime(settings) };
  }

  function authorize(me, op, model, state) {
    if (me.demo || me.access === 'team') return;
    if (me.access === 'pm') {
      if (op.kind === 'note' && me.pmProjects.includes(Number(op.p))) return;
      throw new UserError('Project managers can only edit shared notes on their projects.');
    }
    if (!MEMBER_OPS.has(op.kind) || (op.kind === 'draft' && !MEMBER_DRAFTS.has(op.v?.kind))) throw new UserError('Ask the team manager to make this change.');
    if (op.kind === 'draft' && op.v.kind === 'private') {
      const block = op.v.blockId && state.privateTime.find(b => b.id === op.v.blockId);
      if (Number(op.v.who) !== me.person || (block && block.who !== me.person)) throw new UserError('You can only protect your own time.');
      return;
    }
    if (op.kind === 'releasePrivate') {
      if (state.privateTime.find(b => b.id === op.id)?.who !== me.person) throw new UserError('You can only release your own time.');
      return;
    }
    if (op.kind === 'log' || op.kind === 'deleteLog') return; // entries are always the caller's own (Jira enforces it in live mode)
    const taskId = op.kind === 'start' ? op.taskId : op.v.taskId;
    if (model.schedule(state).get(taskId)?.who !== me.person) throw new UserError('You can only update your own assignments.');
  }

  const activeProjects = settings => settings.projects.map((p, i) => ({ ...p, i })).filter(p => p.jiraKey && !p.archived);

  /** Read open issues of all connected projects and merge them into the plan. Saves nothing unless every page succeeded. */
  async function doRefresh(settings, state, day, active, by) {
    const fields = issueFields(settings), byKey = new Map(active.map(p => [p.jiraKey, p.i]));
    // One search for every project on the default filter; projects with their own JQL need their own search.
    const plain = active.filter(p => !p.jql), custom = active.filter(p => p.jql), open = [];
    if (plain.length) for (const issue of await searchAll('project in (' + plain.map(p => '"' + p.jiraKey + '"').join(',') + ') AND statusCategory != Done ORDER BY Rank ASC', fields)) open.push({ p: byKey.get(issue.fields?.project?.key), issue });
    for (const p of custom) for (const issue of await searchAll(p.jql, fields)) open.push({ p: p.i, issue });
    const seen = new Set(), unique = open.filter(({ p, issue }) => p !== undefined && !seen.has(issue.id) && seen.add(issue.id));
    const { tasks, unmapped } = mapIssues(unique, settings, state.completed, day);
    const next = mergeTasks({ ...state, unmapped: unmapped.slice(0, 200), unmappedTotal: unmapped.length, refreshedAt: new Date().toISOString() }, tasks);
    createModel(settings, day).schedule(next);
    logChange(next, by, 'Refreshed from Jira: ' + tasks.length + ' issues planned, ' + unmapped.length + ' need mapping');
    await savePlan(next, settings, day, state.rev);
  }

  const api = {
    getWorkspace: (ctx, { demo, range }) => workspace(ctx, demo, range),

    async apply(ctx, { op, demo, opId, range }) {
      const { settings, state } = await load(ctx.today);
      const me = identify(settings, ctx.accountId, demo);
      if (!me) throw new UserError('You are not on the planning team.');
      if (!op || typeof op.kind !== 'string') throw new UserError('Unknown change.');
      const model = createModel(settings, ctx.today);
      authorize(me, op, model, state);

      if (op.kind === 'log' || op.kind === 'deleteLog') {
        if (liveTime(settings)) return workspace(ctx, demo, weekOf(await writeWorklog(settings, state, op)));
        // Demo: entries live in month keys and never rewrite the plan. New entries carry a client-made id, so a retry overwrites.
        const e = op.entry ?? {};
        const months = [...new Set([op.kind === 'log' ? e.date : op.date, e.prevDate].filter(Boolean).map(monthOf))];
        if (!months.length || !months.every(m => /^\d{4}-\d{2}$/.test(m))) throw new UserError('Choose a date.');
        const known = state.logMonths.length;
        await writeLogs(state, applyLogOp(await readLogs(months), op, me, state.tasks), months);
        if (state.logMonths.length !== known) await savePlan(state, settings, ctx.today, state.rev);
        return workspace(ctx, demo, weekOf(op.kind === 'log' ? e.date : op.date));
      }

      if (opId && state.ops.includes(opId)) return workspace(ctx, demo, range); // retried request: already applied
      let next;
      if (op.kind === 'reset') {
        if (!settings.demo) throw new UserError('Only the demo plan can be reset.');
        await writeLogs(state, [], state.logMonths);
        next = { ...sampleState(settings), logMonths: state.logMonths };
        logChange(next, me.name, 'Reset the demo plan');
      } else {
        // Previews are calculated against a revision; refuse to apply one that is out of date.
        if (op.kind === 'draft' && op.baseRev !== state.rev) throw new UserError('Someone else changed the plan. Review the change again.', 'stale');
        const result = model.applyOp(state, op, me);
        next = result.next;
        logChange(next, me.name, result.summary);
      }
      next.ops = [...state.ops, opId].filter(Boolean).slice(-50);
      await savePlan(next, settings, ctx.today, state.rev);
      return workspace(ctx, demo, range);
    },

    /** Team manager: set the Jira assignee to the planned owner, or the Jira due date to the forecast finish. */
    async pushToJira(ctx, { taskId, field, range }) {
      const { settings, state } = await load(ctx.today);
      const me = identify(settings, ctx.accountId);
      if (settings.demo || !jira) throw new UserError('Writing to Jira works in live mode inside Jira.');
      if (me?.access !== 'team') throw new UserError('Only the team manager can update Jira.');
      const model = createModel(settings, ctx.today), x = model.schedule(state).get(taskId);
      const next = structuredClone(state), t = next.tasks.find(t => t.id === taskId && t.key);
      if (!t || !x) throw new UserError('This task is not a Jira issue.');
      if (field === 'assignee') {
        const person = settings.people[x.who];
        if (!person?.accountId) throw new UserError('Link ' + (person?.name ?? 'this person') + ' to a Jira user in Relay settings first.');
        await jira.updateIssue(t.key, { assignee: { accountId: person.accountId } });
        t.assignee = { id: person.accountId, name: person.name };
        logChange(next, me.name, t.key + ': Jira assignee set to ' + person.name);
      } else if (field === 'duedate') {
        if (!Number.isFinite(x.end)) throw new UserError('This task has no forecast yet.');
        const due = model.cal.isoOfDay(Math.floor((x.end - 1) / model.spd));
        await jira.updateIssue(t.key, { duedate: due });
        logChange(next, me.name, t.key + ': Jira due date set to ' + due);
      } else throw new UserError('Unknown Jira update.');
      await savePlan(next, settings, ctx.today, state.rev);
      return workspace(ctx, undefined, range);
    },

    async getSettings(ctx) {
      if (!(await ctx.isAdmin())) throw new UserError('Only Jira administrators can change Relay settings.');
      const { settings, state } = await load(ctx.today);
      return { settings, completed: state.completed, unmapped: state.unmapped, unmappedTotal: state.unmappedTotal ?? state.unmapped.length, refreshedAt: state.refreshedAt ?? null, today: ctx.today, jira: !!jira };
    },

    async saveSettings(ctx, { settings: input, switchMode }) {
      if (!(await ctx.isAdmin())) throw new UserError('Only Jira administrators can change Relay settings.');
      const { settings: prev, state } = await load(ctx.today);
      if (switchMode) {
        const settings = prev.demo ? liveSettings(prev) : sampleSettings();
        // Going live starts with the admin who switched as team manager, so they can open the planner straight away.
        if (prev.demo && jira) settings.people = [{ name: (await jira.myself()).displayName, role: '', access: 'team', skills: settings.systems.map((_, i) => i), accountId: ctx.accountId, pmProjects: [], archived: false, days: [0, 1, 2, 3, 4], hoursPerDay: settings.general.workdayHours }];
        await writeLogs(state, [], state.logMonths);
        await store.set('settings', settings);
        const next = { ...(settings.demo ? sampleState(settings) : emptyState(settings)), logMonths: state.logMonths };
        logChange(next, 'Admin', settings.demo ? 'Switched to demo data' : 'Switched to live Jira data');
        await savePlan(next, settings, ctx.today, state.rev);
        return api.getSettings(ctx);
      }
      const settings = validateSettings({ ...input, demo: prev.demo }, prev);
      // Queued tasks nobody can cover any more go back to "Needs mapping"; anything else unschedulable refuses the save.
      const next = normalize(state, settings), model = createModel(settings, ctx.today);
      const orphan = t => !t.started && !t.history?.length && !model.eligible(t).length;
      next.unmapped = [...next.unmapped, ...next.tasks.filter(orphan).map(t => ({ key: t.key ?? '', summary: t.name, project: model.projects[t.p]?.name ?? '', reason: 'Nobody covers ' + settings.systems[t.s] + ' after the settings change.' }))];
      next.tasks = next.tasks.filter(t => !orphan(t));
      model.schedule(next);
      logChange(next, 'Admin', 'Settings saved');
      await store.set('settings', settings);
      await savePlan(next, settings, ctx.today, state.rev);
      return api.getSettings(ctx);
    },

    /** Admin: someone left. Remove their name, Jira link, private time and absences; their work records stay anonymous. */
    async forgetPerson(ctx, { index }) {
      if (!(await ctx.isAdmin())) throw new UserError('Only Jira administrators can change Relay settings.');
      const { settings, state } = await load(ctx.today), i = Number(index);
      if (!settings.people[i]) throw new UserError('Choose a person.');
      settings.people[i] = { name: 'Former member ' + (i + 1), role: '', access: 'member', skills: [], accountId: null, pmProjects: [], archived: true, days: [0, 1, 2, 3, 4], hoursPerDay: settings.general.workdayHours };
      const next = { ...state, privateTime: state.privateTime.filter(b => b.who !== i), leave: state.leave.filter(l => l.who !== i) };
      logChange(next, 'Admin', 'Removed the personal data of former member ' + (i + 1));
      await store.set('settings', settings);
      await savePlan(next, settings, ctx.today, state.rev);
      return api.getSettings(ctx);
    },

    async refresh(ctx, { range } = {}) {
      const { settings, state } = await load(ctx.today);
      const me = identify(settings, ctx.accountId);
      await doRefresh(settings, state, ctx.today, await jiraProjectsFor(ctx, settings, me), me?.name ?? 'Admin');
      return workspace(ctx, undefined, range);
    },

    /** Learn from time logged on finished Jira issues. Separate from refresh so refresh stays fast. */
    async importHistory(ctx) {
      const { settings, state } = await load(ctx.today);
      const active = await jiraProjectsFor(ctx, settings, identify(settings, ctx.accountId));
      // shortcut: the 1000 most recently resolved issues only; page in batches (async events) if a site needs more.
      const done = await searchAll('project in (' + active.map(p => '"' + p.jiraKey + '"').join(',') + ') AND statusCategory = Done AND timespent > 0 AND resolved >= -' + settings.general.historyMonths * 30 + 'd ORDER BY resolved DESC', issueFields(settings), 1000);
      const byKey = new Map(active.map(p => [p.jiraKey, p.i]));
      const relay = state.completed.filter(c => c.source !== 'jira'), recorded = new Set(relay.map(c => c.id).filter(Boolean));
      // A task finished in Relay is already in history; its Jira time would count it twice.
      const fromJira = historyFromIssues(done.map(issue => ({ p: byKey.get(issue.fields?.project?.key), issue })).filter(x => x.p !== undefined), settings).filter(h => !recorded.has(h.id));
      const next = { ...state, completed: [...relay, ...fromJira] };
      logChange(next, 'Admin', 'Imported ' + fromJira.length + ' finished issues as estimation history');
      await savePlan(next, settings, ctx.today, state.rev);
      return { imported: fromJira.length };
    },

    async jiraProjects(ctx) {
      if (!(await ctx.isAdmin())) throw new UserError('Only Jira administrators can change Relay settings.');
      if (!jira) return { projects: [] };
      return { projects: (await jira.projects()).values.map(p => ({ key: p.key, name: p.name })) };
    },

    async searchUsers(ctx, { query }) {
      if (!(await ctx.isAdmin())) throw new UserError('Only Jira administrators can change Relay settings.');
      if (!jira) return { users: [] };
      const q = String(query || '').trim().slice(0, 100);
      if (q.length < 2) return { users: [] };
      return { users: (await jira.users(q)).filter(u => u.accountType === 'atlassian').map(u => ({ accountId: u.accountId, name: u.displayName })) };
    }
  };

  /** Checks shared by refresh and history import; returns the connected, active projects. */
  async function jiraProjectsFor(ctx, settings, me) {
    if (settings.demo) throw new UserError('Switch Relay to live mode in settings to read from Jira.');
    if (me?.access !== 'team' && !(await ctx.isAdmin())) throw new UserError('Only the team manager can read from Jira.');
    if (!jira) throw new UserError('Jira is only available when Relay runs inside Jira.');
    const active = activeProjects(settings);
    if (!active.length) throw new UserError('Connect at least one Jira project in Relay settings.');
    return active;
  }

  /** All pages of a search. Stops quietly at `limit`, or refuses past 5000 when no limit is given. */
  async function searchAll(jql, fields, limit) {
    const issues = [];
    let nextPageToken;
    do {
      const page = await jira.search({ jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) });
      issues.push(...page.issues);
      nextPageToken = page.isLast ? undefined : page.nextPageToken;
      if (limit && issues.length >= limit) return issues.slice(0, limit);
      if (issues.length > 5000) throw new UserError('The project filters return more than 5000 open issues. Narrow the JQL in Relay settings.');
    } while (nextPageToken);
    return issues;
  }

  /**
   * Scheduled job (every 5 minutes), with the app's own Jira access. Not reachable from the browser.
   * A one-issue search checks whether anything changed since the last refresh; the full refresh runs only then,
   * and at least hourly so deleted or moved issues (which an "updated" search can't see) also drop out.
   */
  async function autoRefresh(now = Date.now()) {
    const day = today(), { settings, state } = await load(day), active = activeProjects(settings);
    if (settings.demo || !jira || !active.length) return { skipped: true };
    const minutes = Math.ceil((now - (Date.parse(state.refreshedAt ?? '') || 0)) / 60000);
    if (minutes < 60) {
      const scope = 'project in (' + active.map(p => '"' + p.jiraKey + '"').join(',') + ')';
      const changed = await jira.search({ jql: scope + ' AND updated >= -' + (minutes + 1) + 'm', fields: ['id'], maxResults: 1 });
      if (!changed.issues?.length) return { skipped: true };
    }
    await doRefresh(settings, state, day, active, 'Automatic refresh');
    return { refreshed: true };
  }

  /** Single entry point: expected problems become { error }, anything else is logged and hidden. */
  async function handle(name, ctx, payload) {
    if (!Object.hasOwn(api, name)) return { error: 'Unknown request.' };
    try {
      return await api[name]({ ...ctx, today: pickDay(payload?.today, today()) }, payload ?? {});
    } catch (e) {
      if (e instanceof UserError) return { error: e.message, code: e.code };
      console.error(name, e);
      return { error: 'Something went wrong. Try again, or ask an admin to check the app logs.' };
    }
  }
  return { ...api, handle, autoRefresh };
}
