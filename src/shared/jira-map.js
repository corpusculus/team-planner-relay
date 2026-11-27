// Maps Jira issues to Relay tasks using the task types' match rules.
import { estimate, multiplier, toSlots } from './estimate.js';

const list = s => String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

export function issueFields(settings) {
  const f = ['summary', 'project', 'issuetype', 'components', 'labels', 'assignee', 'timeoriginalestimate', 'issuelinks', 'timespent', 'resolutiondate'];
  return settings.general.storyPointsField ? [...f, settings.general.storyPointsField] : f;
}

/**
 * The Relay project an issue of a connected Jira project belongs to. Several Relay projects can share one Jira project,
 * split by Jira component: the first whose components the issue has, else the one without components (the rest).
 */
export function projectOf(settings, fields) {
  const comps = (fields?.components || []).map(c => String(c.name).toLowerCase());
  const same = settings.projects.map((p, i) => ({ p, i })).filter(({ p }) => p.jiraKey && p.jiraKey === fields?.project?.key && !p.archived);
  return (same.find(({ p }) => list(p.components).some(c => comps.includes(c))) ?? same.find(({ p }) => !list(p.components).length))?.i;
}

/** Index of the first task type whose rules all match, or -1. A type without rules only applies to tasks added in Relay. */
export function matchType(fields, types) {
  const it = String(fields.issuetype?.name || '').toLowerCase();
  const labels = (fields.labels || []).map(l => l.toLowerCase());
  const comps = (fields.components || []).map(c => String(c.name).toLowerCase());
  return types.findIndex(t => {
    if (t.archived) return false;
    const its = list(t.issueTypes), ls = list(t.labels), cs = list(t.components);
    if (!its.length && !ls.length && !cs.length) return false;
    return (!its.length || its.includes(it)) && (!ls.length || ls.some(l => labels.includes(l))) && (!cs.length || cs.some(c => comps.includes(c)));
  });
}

function systemOf(fields, type, settings) {
  const comps = (fields.components || []).map(c => String(c.name).toLowerCase());
  const byComponent = settings.systems.findIndex(s => comps.includes(s.toLowerCase()));
  return byComponent >= 0 ? byComponent : settings.types[type].system;
}

const covers = (settings, p, s) => [settings.projects[p].lead, settings.projects[p].back]
  .some(w => w != null && settings.people[w] && !settings.people[w].archived && settings.people[w].skills.includes(s));

/** issues: [{ p, issue }]. Returns { tasks, unmapped }. Tasks carry no rank; the caller merges them into the plan. */
export function mapIssues(issues, settings, completed, todayIso) {
  const tasks = [], unmapped = [], g = settings.general, linkType = (g.blockLinkType || 'Blocks').toLowerCase();
  const person = accountId => settings.people.findIndex(x => x.accountId && x.accountId === accountId && !x.archived);
  for (const { p, issue } of issues) {
    const f = issue.fields || {}, base = { key: issue.key, summary: String(f.summary || '').slice(0, 120), project: settings.projects[p].name };
    const type = matchType(f, settings.types);
    if (type < 0) { unmapped.push({ ...base, reason: 'No task type matches issue type “' + (f.issuetype?.name || '?') + '”.' }); continue; }
    const s = systemOf(f, type, settings);
    if (!covers(settings, p, s)) { unmapped.push({ ...base, reason: 'Nobody on ' + base.project + ' covers ' + settings.systems[s] + '.' }); continue; }
    const est = estimate(settings, { type, p, s, labels: f.labels, originalEstimateSec: f.timeoriginalestimate, storyPoints: Number(f[g.storyPointsField]) || 0 }, completed, todayIso);
    const blockers = (f.issuelinks || []).filter(l => l.type?.name?.toLowerCase() === linkType && l.inwardIssue).map(l => 'jira-' + l.inwardIssue.id);
    const prefer = f.assignee ? person(f.assignee.accountId) : -1;
    tasks.push({
      id: 'jira-' + issue.id, key: issue.key, name: base.summary || issue.key, p, s, type, labels: f.labels || [],
      work: Math.max(1, toSlots(est.hours, g.slotHours)), buffer: toSlots(est.buffer, g.slotHours), source: est.source,
      deps: blockers, ready: 0, assignee: f.assignee ? { id: f.assignee.accountId, name: f.assignee.displayName } : null, ...(prefer >= 0 ? { prefer } : {})
    });
  }
  return { tasks, unmapped };
}

/** Finished Jira issues with logged time become history records for the estimator. */
export function historyFromIssues(issues, settings) {
  const out = [];
  for (const { p, issue } of issues) {
    const f = issue.fields || {}, type = matchType(f, settings.types);
    if (type < 0 || !(f.timespent > 0) || !f.resolutiondate) continue;
    const s = systemOf(f, type, settings);
    out.push({ id: 'jira-' + issue.id, type, p, s, hours: f.timespent / 3600, mult: multiplier(settings, p, s, f.labels).value, at: f.resolutiondate.slice(0, 10), source: 'jira' });
  }
  return out;
}

/** Merge a fresh Jira mapping into the plan, keeping everything Relay recorded about each issue. */
export function mergeTasks(state, mapped) {
  const prev = new Map(state.tasks.map(t => [t.id, t])), ids = new Set(mapped.map(t => t.id));
  let rank = Math.max(0, ...state.tasks.map(t => t.rank)) + 1;
  const keep = ['started', 'wait', 'history', 'actual', 'revised', 'firstStart', 'ready', 'rank'];
  const tasks = mapped.map(t => {
    const old = prev.get(t.id);
    if (!old) return { ...t, rank: rank++ };
    const merged = { ...t };
    for (const k of keep) if (old[k] !== undefined) merged[k] = old[k];
    if (old.manual) Object.assign(merged, { work: old.work, buffer: old.buffer, manual: true, source: old.source });
    return merged;
  });
  // Keep tasks added in Relay, and Jira tasks that left the filter while work is recorded on them.
  for (const old of state.tasks) {
    if (ids.has(old.id)) continue;
    const isJira = old.id.startsWith('jira-');
    if (!isJira || ((old.started || old.history?.length) && old.actual == null)) tasks.push(isJira ? { ...old, gone: true } : old);
  }
  const all = new Set(tasks.map(t => t.id));
  for (const t of tasks) t.deps = (t.deps ?? []).filter(id => all.has(id));
  return { ...state, tasks, fixed: state.fixed.filter(f => all.has(f.taskId)) };
}
