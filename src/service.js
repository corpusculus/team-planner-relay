// Relay backend logic. Storage and Jira are injected so the same code runs in Forge and in the local preview.
import { createModel, normalize, emptyState, UserError } from './shared/model.js';
import { sampleSettings, sampleState, liveSettings } from './shared/defaults.js';
import { validateSettings } from './shared/validate.js';
import { mapIssues, historyFromIssues, mergeTasks, issueFields } from './shared/jira-map.js';

const MEMBER_OPS = new Set(['start', 'log', 'deleteLog', 'releasePrivate', 'draft']);
const MEMBER_DRAFTS = new Set(['private', 'pause', 'resume', 'estimate', 'finish', 'revise']);

export function createService({ store, jira, today = () => new Date().toISOString().slice(0, 10) }) {
  async function load() {
    const settings = (await store.get('settings')) ?? sampleSettings();
    const raw = await store.get('plan');
    return { settings, state: normalize(raw ?? (settings.demo ? sampleState(settings) : emptyState(settings)), settings) };
  }
  const save = state => store.set('plan', state);

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

  /** Remove what the caller's role must not see. Demo data is fictional and returned whole so roles can be previewed. */
  function redact(state, me) {
    if (me.demo) return state;
    const s = structuredClone(state);
    s.ops = [];
    s.privateTime = s.privateTime.map(b => (me.access === 'member' && b.who === me.person ? b : { ...b, name: 'Private time' }));
    if (me.access === 'member') s.logs = s.logs.filter(e => e.who === me.person);
    if (me.access === 'team') s.logs = s.logs.map(e => ({ ...e, note: '' }));
    if (me.access === 'pm') {
      const mine = new Set(me.pmProjects);
      s.tasks = s.tasks.map(t => mine.has(t.p)
        ? (t.wait && !t.wait.shared ? { ...t, wait: { ...t.wait, reason: 'Waiting' } } : t)
        : { ...t, name: 'Other team work', key: undefined, wait: t.wait ? { who: t.wait.who, reason: '', shared: false } : undefined });
      s.logs = s.logs.filter(e => mine.has(e.p)).map(e => ({ ...e, note: '', who: -1 }));
      s.notes = Object.fromEntries(Object.entries(s.notes).filter(([p]) => mine.has(Number(p))));
      s.completed = [];
      s.unmapped = [];
    }
    return s;
  }

  async function workspace(ctx, demo) {
    const { settings, state } = await load();
    const me = identify(settings, ctx.accountId, demo);
    if (!me) return { notMember: true, isAdmin: await ctx.isAdmin() };
    return { settings, state: redact(state, me), me, today: today() };
  }

  function authorize(me, op, model, state) {
    if (me.demo || me.access === 'team') return;
    if (me.access === 'pm') {
      if (op.kind === 'note' && me.pmProjects.includes(Number(op.p))) return;
      throw new UserError('Project managers can only edit shared notes on their projects.');
    }
    if (!MEMBER_OPS.has(op.kind) || (op.kind === 'draft' && !MEMBER_DRAFTS.has(op.v?.kind))) throw new UserError('Ask the team manager to make this change.');
    const plan = model.schedule(state);
    if (op.kind === 'draft' && op.v.kind === 'private') {
      const block = op.v.blockId && state.privateTime.find(b => b.id === op.v.blockId);
      if (Number(op.v.who) !== me.person || (block && block.who !== me.person)) throw new UserError('You can only protect your own time.');
      return;
    }
    if (op.kind === 'releasePrivate') {
      if (state.privateTime.find(b => b.id === op.id)?.who !== me.person) throw new UserError('You can only release your own time.');
      return;
    }
    if (op.kind === 'log' || op.kind === 'deleteLog') return; // applyOp scopes entries to the caller
    const taskId = op.kind === 'start' ? op.taskId : op.v.taskId;
    if (plan.get(taskId)?.who !== me.person) throw new UserError('You can only update your own assignments.');
  }

  const api = {
    getWorkspace: (ctx, { demo }) => workspace(ctx, demo),

    async apply(ctx, { op, demo, opId }) {
      const { settings, state } = await load();
      const me = identify(settings, ctx.accountId, demo);
      if (!me) throw new UserError('You are not on the planning team.');
      if (!op || typeof op.kind !== 'string') throw new UserError('Unknown change.');
      if (opId && state.ops.includes(opId)) return workspace(ctx, demo); // retried request: already applied
      let next;
      if (op.kind === 'reset') {
        if (!settings.demo) throw new UserError('Only the demo plan can be reset.');
        next = sampleState(settings);
      } else {
        const model = createModel(settings, today());
        authorize(me, op, model, state);
        // Previews are calculated against a revision; refuse to apply one that is out of date.
        if (op.kind === 'draft' && op.baseRev !== state.rev) throw new UserError('Someone else changed the plan. Review the change again.', 'stale');
        next = model.applyOp(state, op, me).next;
      }
      // shortcut: read-check-write is not atomic (Forge KVS lacks compare-and-set on plain keys); fine for one team, use KVS transactions on an entity if edits collide.
      next.rev = state.rev + 1;
      next.ops = [...state.ops, opId].filter(Boolean).slice(-50);
      await save(next);
      return workspace(ctx, demo);
    },

    async getSettings(ctx) {
      if (!(await ctx.isAdmin())) throw new UserError('Only Jira administrators can change Relay settings.');
      const { settings, state } = await load();
      return { settings, completed: state.completed, unmapped: state.unmapped, refreshedAt: state.refreshedAt ?? null, today: today(), jira: !!jira };
    },

    async saveSettings(ctx, { settings: input, switchMode }) {
      if (!(await ctx.isAdmin())) throw new UserError('Only Jira administrators can change Relay settings.');
      const { settings: prev, state } = await load();
      if (switchMode) {
        const settings = prev.demo ? liveSettings(prev) : sampleSettings();
        await store.set('settings', settings);
        await save({ ...(settings.demo ? sampleState(settings) : emptyState(settings)), rev: state.rev + 1 });
        return api.getSettings(ctx);
      }
      const settings = validateSettings({ ...input, demo: prev.demo }, prev);
      // Queued tasks nobody can cover any more go back to "Needs mapping"; anything else unschedulable refuses the save.
      const next = normalize(state, settings), model = createModel(settings, today());
      const orphan = t => !t.started && !t.history?.length && !model.eligible(t).length;
      next.unmapped = [...next.unmapped, ...next.tasks.filter(orphan).map(t => ({ key: t.key ?? '', summary: t.name, project: model.projects[t.p]?.name ?? '', reason: 'Nobody covers ' + settings.systems[t.s] + ' after the settings change.' }))];
      next.tasks = next.tasks.filter(t => !orphan(t));
      model.schedule(next);
      await store.set('settings', settings);
      await save({ ...next, rev: state.rev + 1 });
      return api.getSettings(ctx);
    },

    async refresh(ctx) {
      const { settings, state } = await load();
      const me = identify(settings, ctx.accountId);
      if (settings.demo) throw new UserError('Switch Relay to live mode in settings to read from Jira.');
      if (me?.access !== 'team' && !(await ctx.isAdmin())) throw new UserError('Only the team manager can refresh from Jira.');
      if (!jira) throw new UserError('Jira is only available when Relay runs inside Jira.');
      const active = settings.projects.map((p, i) => ({ ...p, i })).filter(p => p.jiraKey && !p.archived);
      if (!active.length) throw new UserError('Connect at least one Jira project in Relay settings.');
      const fields = issueFields(settings), open = [], done = [];
      // All pages must succeed before anything is saved, so a failed refresh never publishes a partial plan.
      for (const p of active) {
        const jql = p.jql || 'project = "' + p.jiraKey + '" AND statusCategory != Done ORDER BY Rank ASC';
        for (const issue of await searchAll(jql, fields)) open.push({ p: p.i, issue });
        if (settings.general.jiraHistory)
          for (const issue of await searchAll('project = "' + p.jiraKey + '" AND statusCategory = Done AND timespent > 0 AND resolved >= -' + settings.general.historyMonths * 30 + 'd', fields)) done.push({ p: p.i, issue });
      }
      const completed = [...state.completed.filter(c => c.source !== 'jira'), ...historyFromIssues(done, settings)];
      const { tasks, unmapped } = mapIssues(open, settings, completed, today());
      const next = mergeTasks({ ...state, completed, unmapped, refreshedAt: new Date().toISOString() }, tasks);
      createModel(settings, today()).schedule(next);
      next.rev = state.rev + 1;
      await save(next);
      return workspace(ctx);
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

  async function searchAll(jql, fields) {
    const issues = [];
    let nextPageToken;
    do {
      const page = await jira.search({ jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) });
      issues.push(...page.issues);
      nextPageToken = page.isLast ? undefined : page.nextPageToken;
      if (issues.length > 5000) throw new UserError('A project filter returns more than 5000 issues. Narrow its JQL in Relay settings.');
    } while (nextPageToken);
    return issues;
  }

  /** Single entry point: expected problems become { error }, anything else is logged and hidden. */
  async function handle(name, ctx, payload) {
    if (!Object.hasOwn(api, name)) return { error: 'Unknown request.' };
    try {
      return await api[name](ctx, payload ?? {});
    } catch (e) {
      if (e instanceof UserError) return { error: e.message, code: e.code };
      console.error(name, e);
      return { error: 'Something went wrong. Try again, or ask an admin to check the app logs.' };
    }
  }
  return { ...api, handle };
}
