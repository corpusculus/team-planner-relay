import { describe, it, expect } from 'vitest';
import { createModel, normalize, applyLogOp } from '../src/shared/model.js';
import { estimate, percentile } from '../src/shared/estimate.js';
import { sampleSettings, sampleState, liveSettings, GENERAL } from '../src/shared/defaults.js';
import { mapIssues, mergeTasks, matchType, historyFromIssues } from '../src/shared/jira-map.js';
import { validateSettings } from '../src/shared/validate.js';
import { createService, pickDay } from '../src/service.js';

const TODAY = '2026-11-26';
const memStore = (init = {}) => { const m = new Map(Object.entries(init)); return { get: async k => structuredClone(m.get(k)), set: async (k, v) => void m.set(k, structuredClone(v)), claim: async k => !m.has(k) && !!m.set(k, 1), m }; };

describe('scheduler', () => {
  it('plans the demo portfolio in 4h slots', () => {
    const settings = sampleSettings(), M = createModel(settings, TODAY), state = sampleState(settings);
    const plan = M.schedule(state);
    expect(plan.get('a2')).toMatchObject({ who: 2, start: 0 });
    expect(Number.isFinite(plan.get('a3').start)).toBe(false); // waiting
    for (const t of state.tasks) {
      const x = plan.get(t.id);
      if (!Number.isFinite(x.start)) continue; // waiting, or after a waiting task
      // Planned working slots equal the remaining work; days off inside the span are skipped.
      expect(Array.from({ length: x.end - x.start }, (_, k) => x.start + k).filter(s => !M.off(x.who, s)).length).toBe(M.remaining(t));
    }
  });

  it('never plans unstarted work before today', () => {
    const settings = sampleSettings(), M = createModel(settings, '2026-12-09'), state = sampleState(settings);
    const plan = M.schedule(state), now = 7 * M.spd; // Wed 9 Dec is workday 7
    for (const t of state.tasks) if (!t.started && Number.isFinite(plan.get(t.id).start)) expect(plan.get(t.id).start).toBeGreaterThanOrEqual(now);
  });

  it('applies a previewed change and records finished work as history', () => {
    const settings = sampleSettings(), M = createModel(settings, TODAY), state = sampleState(settings);
    const { next } = M.applyOp(state, { kind: 'draft', v: { kind: 'finish', taskId: 'a2', hours: 12 } }, { person: 2 });
    expect(next.tasks.find(t => t.id === 'a2').actual).toBe(3);
    expect(next.completed.at(-1)).toMatchObject({ type: 2, p: 2, s: 2, hours: 12 });
  });

  it('rescales positions when the slot size changes', () => {
    const settings = sampleSettings(), state = sampleState(settings);
    settings.general.slotHours = 2;
    const n = normalize(state, settings);
    expect(n.leave[0]).toEqual({ who: 4, start: 12, len: 8 });
    expect(n.tasks.find(t => t.id === 'a0').work).toBe(state.tasks.find(t => t.id === 'a0').work * 2);
    expect(() => createModel(settings, TODAY).schedule(n)).not.toThrow();
  });
});

describe('estimator', () => {
  const base = () => {
    const s = sampleSettings();
    s.types[1] = { ...s.types[1], baseHours: 12, bufferHours: 4 };
    s.projects[1] = { ...s.projects[1], sizes: { 1: 'L' }, factors: ['vpn'] };
    return s;
  };
  it('uses type default × size × complexity without history', () => {
    const e = estimate(base(), { type: 1, p: 1, s: 1 }, [], TODAY);
    expect(e.hours).toBeCloseTo(21.6);
    expect(Math.ceil(e.hours / 4) * 4).toBe(24);
    expect(e.source).toContain('Large system');
  });
  it('prefers the most specific history and normalises by multiplier', () => {
    const s = base(), h = (p, hours, mult) => ({ type: 1, p, s: 1, hours, mult, at: '2026-06-01' });
    const other = [h(5, 10, 1), h(6, 10, 1), h(7, 10, 1)];
    expect(estimate(s, { type: 1, p: 1, s: 1 }, other, TODAY).hours).toBeCloseTo(10 * 1.8); // same system, scaled to L×VPN
    const own = [h(1, 30, 1.8), h(1, 36, 1.8), h(1, 45, 1.8)];
    const e = estimate(s, { type: 1, p: 1, s: 1 }, [...other, ...own], TODAY);
    expect(e.source).toContain('same project and system');
    expect(e.hours).toBeCloseTo(percentile([30, 36, 45], 70));
  });
  it('ignores history outside the window and can use Jira estimates', () => {
    const s = base();
    const old = [1, 2, 3].map(() => ({ type: 1, p: 1, s: 1, hours: 99, mult: 1, at: '2024-01-01' }));
    expect(estimate(s, { type: 1, p: 1, s: 1 }, old, TODAY).source).toMatch(/^Type default/);
    s.types[1].source = 'jira-estimate';
    expect(estimate(s, { type: 1, p: 1, s: 1, originalEstimateSec: 7200 }, [], TODAY)).toMatchObject({ hours: 2, source: 'Jira original estimate' });
  });
});

describe('jira mapping', () => {
  const live = () => {
    const s = liveSettings(sampleSettings());
    s.people = [{ name: 'Ana Silva', role: '', access: 'team', skills: [1, 2], accountId: 'acc-ana', pmProjects: [], archived: false }];
    s.projects = [{ name: 'Pilot', jiraKey: 'PIL', jql: '', due: '', lead: 0, back: null, sizes: {}, factors: [], archived: false }];
    return s;
  };
  const issue = (id, fields) => ({ p: 0, issue: { id, key: 'PIL-' + id, fields: { summary: 'Issue ' + id, issuetype: { name: 'Task' }, labels: [], components: [], ...fields } } });

  it('matches types, systems and blockers, and reports what it cannot plan', () => {
    const s = live();
    expect(matchType({ issuetype: { name: 'Bug' } }, s.types)).toBe(-1);
    const { tasks, unmapped } = mapIssues([
      issue('1', { components: [{ name: 'Integration' }], assignee: { accountId: 'acc-ana' } }),
      issue('2', { components: [{ name: 'Data' }], issuelinks: [{ type: { name: 'Blocks' }, inwardIssue: { id: '1' } }] }),
      issue('3', { issuetype: { name: 'Bug' } }),
      issue('4', { components: [{ name: 'Controls' }] })
    ], s, [], TODAY);
    expect(tasks.map(t => [t.id, t.s, t.deps, t.prefer])).toEqual([['jira-1', 1, [], 0], ['jira-2', 2, ['jira-1'], undefined]]);
    expect(unmapped.map(u => u.key)).toEqual(['PIL-3', 'PIL-4']);
  });

  it('keeps Relay progress across refreshes', () => {
    const s = live(), M = createModel(s, TODAY);
    const first = mapIssues([issue('1', { components: [{ name: 'Integration' }] })], s, [], TODAY).tasks;
    let state = mergeTasks(normalize({ tasks: [] }, s), first);
    state = M.applyOp(state, { kind: 'start', taskId: 'jira-1' }, { person: 0 }).next;
    const again = mergeTasks(state, mapIssues([issue('1', { summary: 'Renamed', components: [{ name: 'Integration' }] })], s, [], TODAY).tasks);
    expect(again.tasks[0]).toMatchObject({ name: 'Renamed', started: { who: 0 } });
    expect(mergeTasks(again, []).tasks[0].gone).toBe(true); // left the filter with work recorded
  });
});

describe('service', () => {
  const liveStore = () => {
    const settings = liveSettings(sampleSettings());
    settings.people = [
      { name: 'Ana Silva', role: '', access: 'member', skills: [1], accountId: 'ana', pmProjects: [], archived: false },
      { name: 'Max Lead', role: '', access: 'team', skills: [1], accountId: 'max', pmProjects: [], archived: false },
      { name: 'Pia PM', role: '', access: 'pm', skills: [], accountId: 'pia', pmProjects: [0], archived: false }
    ];
    settings.projects = [0, 1].map(i => ({ name: 'P' + i, jiraKey: '', jql: '', due: '', lead: 0, back: 1, sizes: {}, factors: [], archived: false }));
    const plan = { rev: 3, unit: { slotHours: 4, workdayHours: 8 }, tasks: [0, 1].map(i => ({ id: 't' + i, p: i, s: 1, type: 1, name: 'Secret ' + i, work: 2, buffer: 1, rank: i, after: null, ready: 0 })), leave: [], fixed: [], notes: { 1: 'internal' }, logs: [], completed: [], unmapped: [], ops: [],
      privateTime: [{ id: 'pt', who: 0, start: 10, len: 1, name: 'Dentist' }] };
    return memStore({ settings, plan });
  };
  const ctx = (accountId, admin = false) => ({ accountId, isAdmin: async () => admin });

  it('enforces roles on changes', async () => {
    const svc = createService({ store: liveStore(), jira: null, today: () => TODAY });
    const urgent = { kind: 'draft', baseRev: 3, v: { kind: 'urgent', p: 0, s: 1, type: 1, name: 'X', hours: 8, buffer: 0, start: 0 } };
    expect((await svc.handle('apply', ctx('ana'), { op: urgent })).error).toMatch(/team manager/);
    expect((await svc.handle('apply', ctx('pia'), { op: { kind: 'note', p: 1, text: 'hi' } })).error).toMatch(/own projects/);
    const pmTask = { kind: 'draft', baseRev: 3, v: { kind: 'queued', p: 1, s: 1, type: 1, name: 'PM task', hours: 8, buffer: 0, start: 0, prefer: 1 } };
    expect((await svc.handle('apply', ctx('pia'), { op: pmTask })).error).toMatch(/own projects/); // project 1 is not Pia's
    const added = await svc.handle('apply', ctx('pia'), { op: { ...pmTask, v: { ...pmTask.v, p: 0 } } });
    expect(added.state.tasks.find(t => t.name === 'PM task')).toMatchObject({ p: 0, prefer: 1 });
    expect((await svc.handle('apply', ctx('stranger'), { op: urgent })).error).toMatch(/not on the planning team/);
    const ok = await svc.handle('apply', ctx('max'), { op: { ...urgent, baseRev: 4 }, opId: 'op-1' });
    expect(ok.state.tasks).toHaveLength(4);
    const replay = await svc.handle('apply', ctx('max'), { op: { ...urgent, baseRev: 4 }, opId: 'op-1' });
    expect(replay.state.tasks).toHaveLength(4); // retried request applied once
    expect((await svc.handle('apply', ctx('max'), { op: urgent })).code).toBe('stale');
  });

  it('only sends a PM what they may see', async () => {
    const svc = createService({ store: liveStore(), jira: null, today: () => TODAY });
    const ws = await svc.handle('getWorkspace', ctx('pia'), {});
    expect(ws.state.tasks.map(t => t.name)).toEqual(['Secret 0', 'Other team work']);
    expect(ws.state.privateTime[0].name).toBe('Private time');
    expect(ws.state.notes).toEqual({});
    const member = await svc.handle('getWorkspace', ctx('ana'), {});
    expect(member.state.privateTime[0].name).toBe('Dentist');
  });

  it('validates settings and keeps lists append-only', async () => {
    const store = liveStore(), svc = createService({ store, jira: null, today: () => TODAY });
    expect((await svc.handle('saveSettings', ctx('max'), { settings: {} })).error).toMatch(/administrators/);
    const s = (await store.get('settings'));
    expect((await svc.handle('saveSettings', ctx('max', true), { settings: { ...s, general: { ...s.general, slotHours: 3 } } })).error).toMatch(/multiple/);
    expect((await svc.handle('saveSettings', ctx('max', true), { settings: { ...s, people: s.people.slice(1) } })).error).toMatch(/Archive/);
    const saved = await svc.handle('saveSettings', ctx('max', true), { settings: { ...s, general: { ...s.general, slotHours: 2 }, evil: 1 } });
    expect(saved.settings.general.slotHours).toBe(2);
    expect(saved.settings.evil).toBeUndefined();
    expect(() => validateSettings({ ...s, general: { ...s.general, planStart: '2026-12-01' } })).toThrow(/Monday/);
  });

  it('keeps the plan unchanged when any Jira page fails', async () => {
    const store = liveStore(), s = await store.get('settings');
    s.projects[0].jiraKey = 'PA';
    await store.set('settings', s);
    let calls = 0;
    const jira = { search: async () => { if (calls++) throw new Error('HTTP 500'); return { issues: [{ id: '1', key: 'PA-1', fields: { project: { key: 'PA' }, issuetype: { name: 'Task' }, components: [{ name: 'Integration' }] } }], nextPageToken: 'next', isLast: false }; } };
    const before = await store.get('plan');
    expect((await createService({ store, jira, today: () => TODAY }).handle('refresh', ctx('max'), {})).error).toBeTruthy();
    expect(await store.get('plan')).toEqual(before);
  });

  it('lets members change only their own assignments and hides other tasks from them', async () => {
    const svc = createService({ store: liveStore(), jira: null, today: () => TODAY });
    // t0 is planned for Ana (lead), t1 for Max (Ana is busy).
    expect((await svc.handle('apply', ctx('ana'), { op: { kind: 'draft', baseRev: 3, v: { kind: 'estimate', taskId: 't1', hours: 4, buffer: 0 } } })).error).toMatch(/own assignments/);
    const ws = await svc.handle('getWorkspace', ctx('ana'), {});
    expect(ws.state.tasks.map(t => t.name)).toEqual(['Secret 0', 'Team work']);
  });

  it('hides issues a PM cannot browse in Jira', async () => {
    const store = liveStore(), plan = await store.get('plan');
    plan.tasks[0] = { ...plan.tasks[0], id: 'jira-100', key: 'PA-1' };
    await store.set('plan', plan);
    const jira = { canBrowse: async ids => (expect(ids).toEqual(['100']), new Set()) };
    const ws = await createService({ store, jira, today: () => TODAY }).handle('getWorkspace', ctx('pia'), {});
    expect(ws.state.tasks[0]).toMatchObject({ name: 'Restricted issue', key: undefined });
  });

  it('stores time entries by month, outside the plan, once per entry id', async () => {
    const store = liveStore(), svc = createService({ store, jira: null, today: () => TODAY });
    const op = { kind: 'log', entry: { id: 'entry-0001', task: 't0', date: '2026-11-27', minutes: 90 } };
    await svc.handle('apply', ctx('ana'), { op });
    const ws = await svc.handle('apply', ctx('ana'), { op }); // retried request
    expect((await store.get('logs:2026-11')).map(e => e.id)).toEqual(['entry-0001']);
    expect((await store.get('plan')).rev).toBe(4); // only the first entry of a new month touches the plan (to remember the month)
    expect(ws.state.logs).toHaveLength(1);
    expect((await svc.handle('apply', ctx('max'), { op: { kind: 'log', entry: { ...op.entry, minutes: 5 } } })).error).toMatch(/your own/);
    await svc.handle('apply', ctx('ana'), { op: { kind: 'log', entry: { ...op.entry, date: '2026-12-01', prevDate: '2026-11-27' } } });
    expect(await store.get('logs:2026-11')).toEqual([]);
    expect((await store.get('logs:2026-12')).map(e => e.date)).toEqual(['2026-12-01']);
  });

  it('does not count a task finished in Relay twice when importing Jira history', async () => {
    const store = liveStore(), s = await store.get('settings'), plan = await store.get('plan');
    s.projects[0].jiraKey = 'PA';
    plan.completed = [{ id: 'jira-100', type: 1, p: 0, s: 1, hours: 8, mult: 1, at: '2026-10-01', source: 'relay' }];
    await store.set('settings', s); await store.set('plan', plan);
    const done = id => ({ id, key: 'PA-' + id, fields: { project: { key: 'PA' }, issuetype: { name: 'Task' }, components: [{ name: 'Integration' }], timespent: 7200, resolutiondate: '2026-10-02T10:00:00.000+0000' } });
    const jira = { search: async () => ({ issues: [done('100'), done('101')], isLast: true }) };
    expect(await createService({ store, jira, today: () => TODAY }).handle('importHistory', ctx('max'), {})).toEqual({ imported: 1 });
    expect((await store.get('plan')).completed.map(c => c.id)).toEqual(['jira-100', 'jira-101']);
  });

  /** Live store with project 0 on Jira key PA and task t0 = issue PA-1 (id 100). */
  const jiraStore = async () => {
    const store = liveStore(), s = await store.get('settings'), plan = await store.get('plan');
    s.projects[0].jiraKey = 'PA';
    s.people[0].accountId = 'ana';
    plan.tasks[0] = { ...plan.tasks[0], id: 'jira-100', key: 'PA-1' };
    await store.set('settings', s); await store.set('plan', plan);
    return store;
  };

  it('lets only one of two saves from the same revision through', async () => {
    const store = liveStore(), svc = createService({ store, jira: null, today: () => TODAY });
    await store.claim('plan-rev:4'); // another save from revision 3 got there first
    const res = await svc.handle('apply', ctx('max'), { op: { kind: 'note', p: 0, text: 'hi' } });
    expect(res.code).toBe('stale');
    expect((await store.get('plan')).notes[0]).toBeUndefined();
  });

  it('records who changed what, and shows it to the team manager only', async () => {
    const svc = createService({ store: liveStore(), jira: null, today: () => TODAY });
    const ws = await svc.handle('apply', ctx('max'), { op: { kind: 'note', p: 0, text: 'Kick-off moved' } });
    expect(ws.state.changes[0]).toMatchObject({ by: 'Max Lead', what: 'Shared project note saved.' });
    expect((await svc.handle('getWorkspace', ctx('ana'), {})).state.changes).toEqual([]);
  });

  it('reads the timesheet from Jira work logs of team members', async () => {
    const store = await jiraStore();
    const jira = {
      search: async ({ jql }) => (expect(jql).toContain('worklogDate >= "2026-11-23"'), { issues: [{ id: '100', key: 'PA-1', fields: { project: { key: 'PA' }, summary: 'Secret 0' } }], isLast: true }),
      worklogs: async () => [
        { id: '9', author: { accountId: 'ana' }, started: '2026-11-24T09:00:00.000+0100', timeSpentSeconds: 5400, comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Checked logs' }] }] } },
        { id: '10', author: { accountId: 'someone-else' }, started: '2026-11-24T09:00:00.000+0100', timeSpentSeconds: 600 }
      ]
    };
    const ws = await createService({ store, jira, today: () => TODAY }).handle('getWorkspace', ctx('ana'), {});
    expect(ws.timeInJira).toBe(true);
    expect(ws.state.logs).toEqual([{ id: '9', issue: '100', who: 0, date: '2026-11-24', minutes: 90, note: 'Checked logs', task: 'jira-100', p: 0, label: 'PA-1 · Secret 0' }]);
  });

  it('writes time as Jira work logs, moving them between issues when needed', async () => {
    const store = await jiraStore(), calls = [];
    const jira = { search: async () => ({ issues: [], isLast: true }), worklogs: async () => [],
      addWorklog: async (...a) => calls.push(['add', ...a]), updateWorklog: async (...a) => calls.push(['update', ...a]), deleteWorklog: async (...a) => calls.push(['delete', ...a]) };
    const svc = createService({ store, jira, today: () => TODAY });
    await svc.handle('apply', ctx('ana'), { op: { kind: 'log', entry: { task: 'jira-100', date: '2026-11-25', minutes: 60, note: 'Done' } } });
    expect(calls[0]).toEqual(['add', 'PA-1', { timeSpentSeconds: 3600, started: '2026-11-25T12:00:00.000+0000', comment: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done' }] }] } }]);
    await svc.handle('apply', ctx('ana'), { op: { kind: 'log', entry: { id: '9', issue: '100', task: 'jira-100', prevTask: 'jira-100', date: '2026-11-25', minutes: 30 } } });
    expect(calls[1].slice(0, 3)).toEqual(['update', '100', '9']);
    expect((await svc.handle('apply', ctx('ana'), { op: { kind: 'log', entry: { task: 't1', date: '2026-11-25', minutes: 30 } } })).error).toMatch(/Jira issues/);
    expect((await svc.handle('apply', ctx('ana'), { op: { kind: 'log', entry: { task: '', date: '2026-11-25', minutes: 30 } } })).error).toMatch(/internal-work issue/);
  });

  it('refreshes every 5 minutes only when Jira changed, and at least hourly', async () => {
    const store = await jiraStore(), plan = await store.get('plan'), now = Date.parse('2026-11-26T10:00:00Z');
    await store.set('plan', { ...plan, refreshedAt: '2026-11-26T09:50:00Z' });
    const issue = { id: '100', key: 'PA-1', fields: { project: { key: 'PA' }, summary: 'Changed', issuetype: { name: 'Task' }, components: [{ name: 'Integration' }] } };
    let changed = false, queries = [];
    const jira = { search: async ({ jql }) => (queries.push(jql), { issues: jql.includes('updated >=') && !changed ? [] : [issue], isLast: true }) };
    const svc = createService({ store, jira, today: () => TODAY });
    expect(await svc.autoRefresh(now)).toEqual({ skipped: true });
    expect(queries).toEqual(['project in ("PA") AND updated >= -11m']);
    changed = true;
    expect(await svc.autoRefresh(now)).toEqual({ refreshed: true });
    const later = Date.parse((await store.get('plan')).refreshedAt) + 61 * 60000;
    changed = false;
    expect(await svc.autoRefresh(later)).toEqual({ refreshed: true }); // hourly full refresh even without changes
  });

  it('refreshes from Jira in live mode only', async () => {
    expect(await createService({ store: memStore(), jira: {}, today: () => TODAY }).autoRefresh()).toEqual({ skipped: true }); // demo
    const store = await jiraStore();
    const jira = { search: async () => ({ issues: [{ id: '100', key: 'PA-1', fields: { project: { key: 'PA' }, summary: 'Renamed', issuetype: { name: 'Task' }, components: [{ name: 'Integration' }] } }], isLast: true }) };
    expect(await createService({ store, jira, today: () => TODAY }).autoRefresh()).toEqual({ refreshed: true });
    const plan = await store.get('plan');
    expect(plan.tasks.find(t => t.id === 'jira-100').name).toBe('Renamed');
    expect(plan.changes[0].by).toBe('Automatic refresh');
  });

  it('removes the personal data of someone who left', async () => {
    const store = liveStore(), svc = createService({ store, jira: null, today: () => TODAY });
    expect((await svc.handle('forgetPerson', ctx('max'), { index: 0 })).error).toMatch(/administrators/);
    const res = await svc.handle('forgetPerson', ctx('max', true), { index: 0 });
    expect(res.settings.people[0]).toMatchObject({ name: 'Former member 1', accountId: null, archived: true });
    expect((await store.get('plan')).privateTime).toEqual([]);
    expect(await store.get('plan-undo')).toEqual({});
  });

  it('lets members manage their own time off only when the setting allows it', async () => {
    const store = liveStore(), svc = createService({ store, jira: null, today: () => TODAY });
    const leave = (baseRev, v) => ({ op: { kind: 'draft', baseRev, v: { kind: 'leave', who: 0, start: 0, days: 2, ...v } } });
    expect((await svc.handle('apply', ctx('ana'), leave(3))).error).toMatch(/team manager/); // off by default
    await store.set('settings', { ...(await store.get('settings')), general: { ...(await store.get('settings')).general, memberLeave: true } });
    expect((await svc.handle('apply', ctx('ana'), leave(3, { who: 1 }))).error).toMatch(/own time off/);
    expect((await svc.handle('apply', ctx('ana'), leave(3))).state.leave).toEqual([{ who: 0, start: 0, len: 4 }]);
    expect((await svc.handle('apply', ctx('ana'), leave(4, { from: 0, start: 4, days: 1 }))).state.leave).toEqual([{ who: 0, start: 4, len: 2 }]); // rescheduled, not added
    expect((await svc.handle('apply', ctx('ana'), leave(5, { from: 0 }))).error).toMatch(/no longer exists/);
    expect((await svc.handle('apply', ctx('pia'), { op: { kind: 'releaseLeave', who: 0, start: 4 } })).error).toBeTruthy();
    expect((await svc.handle('apply', ctx('ana'), { op: { kind: 'releaseLeave', who: 0, start: 4 } })).state.leave).toEqual([]);
  });

  const setGeneral = async (store, g) => { const s = await store.get('settings'); await store.set('settings', { ...s, general: { ...s.general, ...g } }); };

  it('lets members request time off for the team manager to approve or decline', async () => {
    const store = liveStore(), svc = createService({ store, jira: null, today: () => TODAY });
    const ask = v => ({ op: { kind: 'requestLeave', v: { kind: 'leave', who: 0, start: 0, len: 1, reason: 'Sick leave', ...v } } });
    expect((await svc.handle('apply', ctx('ana'), ask())).error).toMatch(/team manager/); // mode is off
    await setGeneral(store, { memberLeave: 'request' });
    expect((await svc.handle('apply', ctx('ana'), { op: { kind: 'draft', baseRev: 3, v: { kind: 'leave', who: 0, start: 0, len: 1 } } })).error).toMatch(/team manager/); // no direct change
    expect((await svc.handle('apply', ctx('ana'), ask({ who: 1 }))).error).toMatch(/own time off/);
    const sent = await svc.handle('apply', ctx('ana'), ask());
    expect(sent.state.leave).toEqual([]);
    const [req] = sent.state.leaveRequests;
    expect(req).toMatchObject({ who: 0, start: 0, len: 1, reason: 'Sick leave', from: null });
    expect((await svc.handle('getWorkspace', ctx('pia'), {})).state.leaveRequests).toEqual([]);
    expect((await svc.handle('apply', ctx('ana'), { op: { kind: 'approveRequest', id: req.id } })).error).toMatch(/team manager/);
    const ok = await svc.handle('apply', ctx('max'), { op: { kind: 'approveRequest', id: req.id } });
    expect(ok.state.leave).toEqual([{ who: 0, start: 0, len: 1, reason: 'Sick leave' }]); // half a day: one 4h slot
    expect(ok.state.leaveRequests).toEqual([]);
    // The reason is for the team manager and the person only.
    expect((await svc.handle('getWorkspace', ctx('pia'), {})).state.leave[0].reason).toBe('');
    expect((await svc.handle('getWorkspace', ctx('ana'), {})).state.leave[0].reason).toBe('Sick leave');
    // Move, declined; removal, cancelled by the member; removal, approved.
    const move = (await svc.handle('apply', ctx('ana'), ask({ from: 0, start: 4 }))).state.leaveRequests[0];
    expect((await svc.handle('apply', ctx('max'), { op: { kind: 'declineRequest', id: move.id } })).state.leave).toHaveLength(1);
    const drop = (await svc.handle('apply', ctx('ana'), { op: { kind: 'requestLeave', v: { who: 0, from: 0, remove: true } } })).state.leaveRequests[0];
    expect((await svc.handle('apply', ctx('max'), { op: { kind: 'cancelRequest', id: drop.id } })).state.leaveRequests).toEqual([]);
    const again = (await svc.handle('apply', ctx('ana'), { op: { kind: 'requestLeave', v: { who: 0, from: 0, remove: true } } })).state.leaveRequests[0];
    expect((await svc.handle('apply', ctx('max'), { op: { kind: 'approveRequest', id: again.id } })).state.leave).toEqual([]);
    expect((await svc.handle('apply', ctx('max'), { op: { kind: 'approveRequest', id: again.id } })).error).toMatch(/already handled/);
  });

  it('undoes only the most recent change, for the team manager', async () => {
    const svc = createService({ store: liveStore(), jira: null, today: () => TODAY });
    await svc.handle('apply', ctx('max'), { op: { kind: 'note', p: 0, text: 'First' } });
    const ws = await svc.handle('apply', ctx('max'), { op: { kind: 'note', p: 0, text: 'Second' } });
    expect(ws.undo).toBe('Shared project note saved.');
    expect((await svc.handle('getWorkspace', ctx('ana'), {})).undo).toBeNull();
    expect((await svc.handle('undo', ctx('ana'), {})).error).toMatch(/team manager/);
    const back = await svc.handle('undo', ctx('max'), {});
    expect(back.state.notes[0]).toBe('First');
    expect(back.state.changes[0].what).toBe('Undid: Shared project note saved.');
    expect(back.undo).toBeNull();
    expect((await svc.handle('undo', ctx('max'), {})).code).toBe('stale'); // one step only
  });

  it('repeats private time weekly and releases the later weeks together', () => {
    const settings = sampleSettings(), M = createModel(settings, TODAY), state = sampleState(settings);
    const { next } = M.applyOp(state, { kind: 'draft', v: { kind: 'private', who: 0, start: 20, hours: 4, name: 'Support duty', repeat: 4 } }, { person: 0 });
    const series = next.privateTime.filter(b => b.name === 'Support duty');
    expect(series.map(b => b.start)).toEqual([20, 30, 40, 50]);
    const after = M.applyOp(next, { kind: 'releasePrivate', id: series[2].id, later: true }, { person: 0 }).next;
    expect(after.privateTime.filter(b => b.name === 'Support duty').map(b => b.start)).toEqual([20, 30]);
  });

  it('moves a dragged task to the chosen person and day, if they cover it', () => {
    const settings = sampleSettings(), M = createModel(settings, TODAY), state = sampleState(settings), plan = M.schedule(state);
    const t = state.tasks.find(t => t.id === 'b5'), other = M.eligible(t).find(w => w !== plan.get('b5').who), nobody = [0, 1, 2, 3, 4].find(w => !M.eligible(t).includes(w));
    const { slots } = M.makeDraft(state, plan, { kind: 'timing', taskId: 'b5', stamp: '2026-12-21', prefer: other });
    expect(slots.get('b5')).toMatchObject({ who: other, start: M.cal.dayIndex('2026-12-21') * M.spd });
    expect(() => M.makeDraft(state, plan, { kind: 'timing', taskId: 'b5', stamp: '2026-12-21', prefer: nobody })).toThrow(/does not cover/);
  });

  it('remembers the estimate and who finished a task, for the accuracy report', () => {
    const settings = sampleSettings(), M = createModel(settings, TODAY), state = sampleState(settings);
    const { next } = M.applyOp(state, { kind: 'draft', v: { kind: 'finish', taskId: 'a2', hours: 12 } }, { person: 2 });
    expect(next.completed.at(-1)).toMatchObject({ est: state.tasks.find(t => t.id === 'a2').work * 4, hours: 12, who: 2 });
  });

  it('moves the Jira status on start and comments on issues whose plan changed', async () => {
    const store = await jiraStore(), calls = [];
    await setGeneral(store, { startStatus: 'In Progress', notifyChanges: true });
    const plan = await store.get('plan');
    plan.tasks[1] = { ...plan.tasks[1], id: 'jira-200', key: 'PA-2' };
    await store.set('plan', plan);
    const jira = { search: async () => ({ issues: [], isLast: true }), worklogs: async () => [], status: async () => 'To Do',
      transitions: async () => [{ id: '11', name: 'Start', to: { name: 'In Progress' } }], transition: async (...a) => calls.push(['transition', ...a]), addComment: async (...a) => calls.push(['comment', ...a]) };
    const svc = createService({ store, jira, today: () => TODAY });
    await svc.handle('apply', ctx('ana'), { op: { kind: 'start', taskId: 'jira-100' } });
    expect(calls).toEqual([['transition', 'PA-1', '11']]);
    // Max goes away for a week: PA-2 (his) finishes later, and he and nobody else is mentioned.
    calls.length = 0;
    const ws = await svc.handle('apply', ctx('max'), { op: { kind: 'draft', baseRev: 4, v: { kind: 'leave', who: 1, start: 0, len: 10 } } });
    expect(ws.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    const [, key, body] = calls[0];
    expect(key).toBe('PA-2');
    expect(body.content[0].content[0]).toEqual({ type: 'mention', attrs: { id: 'max' } });
    expect(body.content[0].content.at(-1).text).toMatch(/^Team plan update: forecast finish moved from/);
    expect(JSON.stringify(body)).not.toMatch(/leave|away/i); // no private detail in Jira
  });

  it('shows the plan of an issue in its Jira panel', async () => {
    const store = await jiraStore(), svc = createService({ store, jira: {}, today: () => TODAY });
    expect(await svc.handle('issuePlan', { ...ctx('anyone'), issueId: '999' }, {})).toEqual({ planned: false });
    const r = await svc.handle('issuePlan', { ...ctx('anyone'), issueId: '100' }, {});
    expect(r).toMatchObject({ planned: true, status: 'Queued', owner: 'Ana Silva', project: 'P0', team: 'Team' });
  });

  it('keeps each team in its own storage and opens the team the caller is on', async () => {
    const store = liveStore(), svc = createService({ store, jira: null, today: () => TODAY });
    expect((await svc.handle('addTeam', ctx('max'), { name: 'Ops' })).error).toMatch(/administrators/);
    expect((await svc.handle('addTeam', ctx('max', true), { name: 'Ops' })).teams).toEqual([{ id: 't0', name: 'Team' }, { id: 't1', name: 'Ops' }]);
    // The new team starts on demo data, so everyone can open it; live team 0 comes first for its members.
    const ws = await svc.handle('getWorkspace', ctx('ana'), {});
    expect(ws).toMatchObject({ team: 't0', teams: [{ id: 't0', name: 'Team' }, { id: 't1', name: 'Ops' }] });
    const ops = await svc.handle('getWorkspace', ctx('ana'), { team: 't1' });
    expect(ops.me.demo).toBe(true);
    await svc.handle('apply', ctx('x'), { team: 't1', op: { kind: 'note', p: 0, text: 'Ops note' } });
    expect((await store.get('t1:plan')).notes[0]).toBe('Ops note');
    expect((await store.get('plan')).notes).toEqual({ 1: 'internal' }); // team 0 untouched
    expect((await svc.handle('getWorkspace', ctx('ana'), { team: 't9' })).team).toBe('t0');
    expect((await svc.handle('apply', ctx('ana'), { team: 't9', op: { kind: 'note' } })).error).toMatch(/no longer exists/);
  });

  it('records time off taken as work logs on the time-off issues, when switched on', async () => {
    const store = await jiraStore(), calls = [], jql = [];
    const jira = { search: async (b) => (jql.push(b.jql), { issues: [{ id: '500', key: 'ABS-2', fields: { project: { key: 'ABS' }, summary: 'Sick leave' } }], isLast: true }),
      worklogs: async () => [{ id: '7', author: { accountId: 'ana' }, started: '2026-11-24T12:00:00.000+0000', timeSpentSeconds: 4 * 3600 }],
      addWorklog: async (...a) => calls.push(a) };
    const svc = createService({ store, jira, today: () => TODAY });
    const off = reason => ({ op: { kind: 'log', entry: { task: 'absence:' + reason, date: '2026-11-25', minutes: 480 } } });
    expect((await svc.handle('apply', ctx('ana'), off('Vacation'))).error).toMatch(/issues for time off/); // switched off
    await setGeneral(store, { absenceToJira: true, absenceIssues: { none: 'ABS-1', 'Sick leave': 'ABS-2' } });
    await svc.handle('apply', ctx('ana'), off('Sick leave'));
    await svc.handle('apply', ctx('ana'), off('Vacation')); // no issue of its own: goes on the first
    expect(calls.map(c => c[0])).toEqual(['ABS-2', 'ABS-1']);
    const ws = await svc.handle('getWorkspace', ctx('ana'), {});
    expect(jql.at(-1)).toContain('key in ("ABS-1","ABS-2")');
    expect(ws.state.logs[0]).toMatchObject({ absence: 'Sick leave', p: null, task: null, label: 'Time off · Sick leave', minutes: 240 });
    expect(() => validateSettings({ ...(sampleSettings()), general: { ...GENERAL, absenceIssues: { none: 'not a key' } } })).toThrow(/Time off issue/);
  });

  it('keeps demo time off entries apart from internal work', () => {
    const tasks = [];
    const [entry] = applyLogOp([], { kind: 'log', entry: { id: 'entry-0002', task: 'absence:Vacation', date: '2026-11-25', minutes: 480 } }, { person: 0 }, tasks);
    expect(entry).toMatchObject({ absence: 'Vacation', task: null, p: null });
    expect(() => applyLogOp([], { kind: 'log', entry: { id: 'entry-0003', task: 'absence:Party', date: '2026-11-25', minutes: 60 } }, { person: 0 }, tasks)).toThrow(/kind of time off/);
  });

  it('sets the Jira assignee to the planned owner', async () => {
    const store = await jiraStore(), calls = [];
    const jira = { search: async () => ({ issues: [], isLast: true }), worklogs: async () => [], updateIssue: async (...a) => calls.push(a) };
    const svc = createService({ store, jira, today: () => TODAY });
    expect((await svc.handle('pushToJira', ctx('ana'), { taskId: 'jira-100', field: 'assignee' })).error).toMatch(/team manager/);
    await svc.handle('pushToJira', ctx('max'), { taskId: 'jira-100', field: 'assignee' });
    expect(calls).toEqual([['PA-1', { assignee: { accountId: 'ana' } }]]);
    expect((await store.get('plan')).tasks[0].assignee).toEqual({ id: 'ana', name: 'Ana Silva' });
  });

  it('uses the caller\'s local date only within a day of UTC', () => {
    expect(pickDay('2026-11-25', '2026-11-26')).toBe('2026-11-25');
    expect(pickDay('2026-11-20', '2026-11-26')).toBe('2026-11-26');
    expect(pickDay('nonsense', '2026-11-26')).toBe('2026-11-26');
  });

  it('makes the admin who switches to live the first team manager', async () => {
    const store = memStore(), jira = { myself: async () => ({ displayName: 'Vera Admin' }) };
    const svc = createService({ store, jira, today: () => TODAY });
    const res = await svc.handle('saveSettings', ctx('vera', true), { switchMode: true });
    expect(res.settings.people).toEqual([expect.objectContaining({ name: 'Vera Admin', accountId: 'vera', access: 'team' })]);
    expect((await svc.handle('getWorkspace', ctx('vera'), {})).notMember).toBeUndefined();
  });
});

describe('availability', () => {
  it('skips holidays and days a part-timer does not work', () => {
    const settings = sampleSettings(), M = createModel(settings, TODAY), plan = M.schedule(sampleState(settings));
    const christmas = M.cal.dayIndex('2026-12-25') * M.spd, dev = 3;
    expect(M.off(0, christmas)).toBe(true);
    expect(M.off(dev, 4 * M.spd)).toBe(true); // Friday
    for (const x of plan.values()) if (Number.isFinite(x.start)) expect(M.off(x.who, x.start)).toBe(false);
    expect(plan.get('a8')).toMatchObject({ who: dev, start: 6, end: 14 }); // Thu, then Mon — Dev's Friday is skipped
  });

  it('plans after every prerequisite', () => {
    const settings = sampleSettings(), M = createModel(settings, TODAY), state = sampleState(settings);
    state.tasks.find(t => t.id === 'b0').deps = ['a0', 'a1'];
    const plan = M.schedule(state);
    expect(plan.get('b0').start).toBeGreaterThanOrEqual(Math.max(plan.get('a0').end, plan.get('a1').end));
  });

  it('turns an old single prerequisite into a list', () => {
    const settings = sampleSettings();
    const n = normalize({ ...sampleState(settings), tasks: [{ id: 'x', after: 'y' }] }, settings);
    expect(n.tasks[0]).toEqual({ id: 'x', deps: ['y'] });
  });
});
