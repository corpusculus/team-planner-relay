// Relay backend logic. Storage and Jira are injected so the same code runs in Forge and in the local preview.
// Storage keys: 'settings', 'plan' (tasks and planning records), 'logs:YYYY-MM' (one month of timesheet entries).
import { createModel, normalize, emptyState, applyLogOp, UserError } from './shared/model.js';
import { sampleSettings, sampleState, liveSettings } from './shared/defaults.js';
import { validateSettings } from './shared/validate.js';
import { mapIssues, historyFromIssues, mergeTasks, issueFields } from './shared/jira-map.js';

const MEMBER_OPS = new Set(['start', 'log', 'deleteLog', 'releasePrivate', 'draft']);
const MEMBER_DRAFTS = new Set(['private', 'pause', 'resume', 'estimate', 'finish', 'revise']);
const MONTH = /^\d{4}-\d{2}$/;
const monthOf = iso => String(iso).slice(0, 7);
const utcToday = () => new Date().toISOString().slice(0, 10);

/** The caller's local date when it is within a day of the server's UTC date (time zones), else the UTC date. */
export function pickDay(client, server) {
  return /^\d{4}-\d{2}-\d{2}$/.test(client ?? '') && Math.abs(Date.parse(client) - Date.parse(server)) <= 86400000 ? client : server;
}

/** What a caller may not see of a task: its Jira title, key and blocker text. */
const hideTask = (t, name) => ({ ...t, name, key: undefined, labels: [], source: '', wait: t.wait ? { who: t.wait.who, reason: '', shared: false } : undefined });

export function createService({ store, jira, today = utcToday }) {
  const readLogs = async months => (await Promise.all(months.map(m => store.get('logs:' + m)))).flatMap(list => list ?? []);
  /** Replace the given months (and any month the entries fall in) with these entries, and remember the months. */
  async function writeLogs(plan, logs, months = []) {
    const byMonth = Object.fromEntries(months.map(m => [m, []]));
    for (const e of logs) (byMonth[monthOf(e.date)] ??= []).push(e);
    await Promise.all(Object.entries(byMonth).map(([m, list]) => store.set('logs:' + m, list)));
    plan.logMonths = [...new Set([...(plan.logMonths ?? []), ...Object.keys(byMonth)])].sort();
  }

  /** Persist the plan. Timesheet entries never stay inside it, and history older than the window is dropped. */
  async function savePlan(state, settings, day) {
    const { logs = [], ...plan } = state;
    if (logs.length) await writeLogs(plan, logs);
    const cutoff = Date.parse(day) - settings.general.historyMonths * 30.44 * 86400000;
    plan.completed = (plan.completed ?? []).filter(c => Date.parse(c.at) >= cutoff);
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
      return { access, person, pmProjects: settings.projects.map((_, i) => i), demo: true };
    }
    const person = settings.people.findIndex(p => p.accountId === accountId && !p.archived);
    if (person < 0) return null;
    const p = settings.people[person];
    return { access: p.access, person, pmProjects: p.access === 'pm' ? p.pmProjects : [], demo: false, name: p.name };
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
      s.logs = s.logs.filter(e => mine.has(e.p)).map(e => ({ ...e, note: '', who: -1 }));
      s.notes = Object.fromEntries(Object.entries(s.notes).filter(([p]) => mine.has(Number(p))));
      s.completed = [];
      s.unmapped = [];
    }
    return s;
  }

  /** Workspace with the timesheet months the page asked for (always including the current month). */
  async function workspace(ctx, demo, months) {
    const { settings, state } = await load(ctx.today);
    const me = identify(settings, ctx.accountId, demo);
    if (!me) return { notMember: true, isAdmin: await ctx.isAdmin() };
    const want = [...new Set([monthOf(ctx.today), ...(Array.isArray(months) ? months : [])])].filter(m => MONTH.test(m)).slice(0, 6);
    state.logs = await readLogs(want.filter(m => state.logMonths.includes(m)));
    return { settings, state: await redact(state, me, createModel(settings, ctx.today)), me, today: ctx.today, logMonths: want };
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
    if (op.kind === 'log' || op.kind === 'deleteLog') return; // applyLogOp scopes entries to the caller
    const taskId = op.kind === 'start' ? op.taskId : op.v.taskId;
    if (model.schedule(state).get(taskId)?.who !== me.person) throw new UserError('You can only update your own assignments.');
  }

  const api = {
    getWorkspace: (ctx, { demo, months }) => workspace(ctx, demo, months),

    async apply(ctx, { op, demo, opId, months }) {
      const { settings, state } = await load(ctx.today);
      const me = identify(settings, ctx.accountId, demo);
      if (!me) throw new UserError('You are not on the planning team.');
      if (!op || typeof op.kind !== 'string') throw new UserError('Unknown change.');
      const model = createModel(settings, ctx.today);
      authorize(me, op, model, state);

      if (op.kind === 'log' || op.kind === 'deleteLog') {
        // Time entries live in month keys: they never rewrite the plan or make someone's preview stale.
        // New entries carry a client-made id, so a retried request overwrites instead of duplicating.
        const e = op.entry ?? {};
        const months = [...new Set([op.kind === 'log' ? e.date : op.date, e.prevDate].filter(Boolean).map(monthOf))];
        if (!months.length || !months.every(m => MONTH.test(m))) throw new UserError('Choose a date.');
        const known = state.logMonths.length;
        await writeLogs(state, applyLogOp(await readLogs(months), op, me, state.tasks), months);
        if (state.logMonths.length !== known) await savePlan(state, settings, ctx.today);
        return workspace(ctx, demo, months);
      }

      if (opId && state.ops.includes(opId)) return workspace(ctx, demo, months); // retried request: already applied
      let next;
      if (op.kind === 'reset') {
        if (!settings.demo) throw new UserError('Only the demo plan can be reset.');
        await writeLogs(state, [], state.logMonths);
        next = { ...sampleState(settings), logMonths: state.logMonths };
      } else {
        // Previews are calculated against a revision; refuse to apply one that is out of date.
        if (op.kind === 'draft' && op.baseRev !== state.rev) throw new UserError('Someone else changed the plan. Review the change again.', 'stale');
        next = model.applyOp(state, op, me).next;
      }
      // shortcut: read-check-write is not atomic (Forge KVS lacks compare-and-set on plain keys); fine for one team, use KVS transactions on an entity if edits collide.
      next.rev = state.rev + 1;
      next.ops = [...state.ops, opId].filter(Boolean).slice(-50);
      await savePlan(next, settings, ctx.today);
      return workspace(ctx, demo, months);
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
        await writeLogs(state, [], state.logMonths);
        await store.set('settings', settings);
        await savePlan({ ...(settings.demo ? sampleState(settings) : emptyState(settings)), rev: state.rev + 1, logMonths: state.logMonths }, settings, ctx.today);
        return api.getSettings(ctx);
      }
      const settings = validateSettings({ ...input, demo: prev.demo }, prev);
      // Queued tasks nobody can cover any more go back to "Needs mapping"; anything else unschedulable refuses the save.
      const next = normalize(state, settings), model = createModel(settings, ctx.today);
      const orphan = t => !t.started && !t.history?.length && !model.eligible(t).length;
      next.unmapped = [...next.unmapped, ...next.tasks.filter(orphan).map(t => ({ key: t.key ?? '', summary: t.name, project: model.projects[t.p]?.name ?? '', reason: 'Nobody covers ' + settings.systems[t.s] + ' after the settings change.' }))];
      next.tasks = next.tasks.filter(t => !orphan(t));
      model.schedule(next);
      await store.set('settings', settings);
      await savePlan({ ...next, rev: state.rev + 1 }, settings, ctx.today);
      return api.getSettings(ctx);
    },

    async refresh(ctx, { months } = {}) {
      const { settings, state } = await load(ctx.today);
      const active = await jiraProjectsFor(ctx, settings, identify(settings, ctx.accountId));
      const fields = issueFields(settings), byKey = new Map(active.map(p => [p.jiraKey, p.i]));
      // One search for every project on the default filter; projects with their own JQL need their own search.
      const plain = active.filter(p => !p.jql), custom = active.filter(p => p.jql);
      const open = [];
      if (plain.length) for (const issue of await searchAll('project in (' + plain.map(p => '"' + p.jiraKey + '"').join(',') + ') AND statusCategory != Done ORDER BY Rank ASC', fields)) open.push({ p: byKey.get(issue.fields?.project?.key), issue });
      for (const p of custom) for (const issue of await searchAll(p.jql, fields)) open.push({ p: p.i, issue });
      const seen = new Set(), unique = open.filter(({ p, issue }) => p !== undefined && !seen.has(issue.id) && seen.add(issue.id));
      // All pages succeeded before this point, so a failed refresh never publishes a partial plan.
      const { tasks, unmapped } = mapIssues(unique, settings, state.completed, ctx.today);
      const next = mergeTasks({ ...state, unmapped: unmapped.slice(0, 200), unmappedTotal: unmapped.length, refreshedAt: new Date().toISOString() }, tasks);
      createModel(settings, ctx.today).schedule(next);
      next.rev = state.rev + 1;
      await savePlan(next, settings, ctx.today);
      return workspace(ctx, undefined, months);
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
      await savePlan({ ...state, completed: [...relay, ...fromJira] }, settings, ctx.today);
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
    const active = settings.projects.map((p, i) => ({ ...p, i })).filter(p => p.jiraKey && !p.archived);
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
  return { ...api, handle };
}
