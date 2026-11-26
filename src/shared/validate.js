// Validates and rebuilds settings from untrusted input. Unknown fields are dropped.
import { UserError } from './model.js';

const fail = msg => { throw new UserError(msg); };
const str = (v, max, label, required = true) => {
  const s = String(v ?? '').trim();
  if (required && !s) fail(label + ' is required.');
  if (s.length > max) fail(label + ' must be at most ' + max + ' characters.');
  return s;
};
const num = (v, min, max, label, int = false) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) fail(label + ' must be ' + (int ? 'a whole number ' : '') + 'between ' + min + ' and ' + max + '.');
  return n;
};
const idx = (v, list, label, nullable = false) => {
  if (nullable && (v === null || v === '' || v === undefined)) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n >= list.length) fail(label + ' is not valid.');
  return n;
};
const isoDate = (v, label) => {
  if (!v) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) fail(label + ' must be a date.');
  return v;
};
const arr = (v, max, label) => {
  if (!Array.isArray(v)) fail(label + ' must be a list.');
  if (v.length > max) fail('At most ' + max + ' ' + label.toLowerCase() + ' are supported.');
  return v;
};

/** prev = currently stored settings. Lists are append-only because plans reference entries by position. */
export function validateSettings(input, prev) {
  const s = input || {};
  const gi = s.general || {};
  const workdayHours = num(gi.workdayHours, 1, 24, 'Hours per workday', true);
  const slotHours = num(gi.slotHours, 1, workdayHours, 'Minimum slot', true);
  if (workdayHours % slotHours) fail('Hours per workday must be a multiple of the minimum slot.');
  const planStart = isoDate(gi.planStart, 'Planning start') || fail('Planning start is required.');
  if (new Date(planStart + 'T00:00:00Z').getUTCDay() !== 1) fail('Planning start must be a Monday.');
  const estimatePercentile = num(gi.estimatePercentile, 1, 99, 'Estimate percentile', true);
  const general = {
    workdayHours, slotHours, planStart, estimatePercentile,
    dayStartHour: num(gi.dayStartHour, 0, 23, 'Day start hour', true),
    bufferPercentile: num(gi.bufferPercentile, estimatePercentile, 99, 'Buffer percentile', true),
    minSamples: num(gi.minSamples, 1, 50, 'Minimum history samples', true),
    historyMonths: num(gi.historyMonths, 1, 60, 'History window', true),
    jiraHistory: !!gi.jiraHistory,
    storyPointsField: /^[a-zA-Z0-9_]{0,40}$/.test(gi.storyPointsField ?? '') ? (gi.storyPointsField ?? '') : fail('Story points field must look like customfield_10016.')
  };
  const systems = arr(s.systems, 50, 'Systems').map((x, i) => str(x, 40, 'System ' + (i + 1)));
  const sizes = arr(s.sizes, 10, 'Size levels').map((z, i) => ({ id: str(z.id, 8, 'Size code ' + (i + 1)), name: str(z.name, 30, 'Size name ' + (i + 1)), multiplier: num(z.multiplier, 0.1, 10, 'Size multiplier') }));
  const sizeIds = new Set(sizes.map(z => z.id));
  if (sizeIds.size !== sizes.length) fail('Size codes must be unique.');
  const defaultSize = sizeIds.has(s.defaultSize) ? s.defaultSize : fail('Choose a default size.');
  const factors = arr(s.factors, 30, 'Complexity factors').map((f, i) => ({
    id: str(f.id, 40, 'Factor id'), name: str(f.name, 40, 'Factor ' + (i + 1)), multiplier: num(f.multiplier, 0.1, 10, 'Factor multiplier'), label: str(f.label, 60, 'Factor label', false)
  }));
  const factorIds = new Set(factors.map(f => f.id));
  if (factorIds.size !== factors.length) fail('Complexity factor ids must be unique.');
  const types = arr(s.types, 100, 'Task types').map((t, i) => {
    const label = 'Task type ' + (i + 1), source = ['relay', 'jira-estimate', 'story-points'].includes(t.source) ? t.source : fail(label + ': choose where the duration comes from.');
    return {
      name: str(t.name, 60, label + ' name'), system: idx(t.system, systems, label + ' system'),
      baseHours: num(t.baseHours, 0.5, 2000, label + ' base hours'), bufferHours: num(t.bufferHours, 0, 2000, label + ' buffer hours'),
      source, hoursPerPoint: num(t.hoursPerPoint ?? 4, 0.25, 200, label + ' hours per point'),
      issueTypes: str(t.issueTypes, 200, label + ' issue types', false), components: str(t.components, 200, label + ' components', false),
      labels: str(t.labels, 200, label + ' labels', false), archived: !!t.archived
    };
  });
  const people = arr(s.people, 100, 'People').map((p, i) => ({
    name: str(p.name, 60, 'Person ' + (i + 1) + ' name'), role: str(p.role, 60, 'Job title', false),
    access: ['member', 'team', 'pm'].includes(p.access) ? p.access : fail('Choose a role for ' + p.name + '.'),
    skills: [...new Set(arr(p.skills || [], 50, 'Skills').map(x => idx(x, systems, 'Skill')))],
    accountId: p.accountId ? str(p.accountId, 128, 'Jira account') : null,
    pmProjects: [...new Set(arr(p.pmProjects || [], 200, 'PM projects').map(x => Number(x)))].filter(x => Number.isInteger(x) && x >= 0 && x < (s.projects?.length ?? 0)),
    archived: !!p.archived
  }));
  const accounts = people.map(p => p.accountId).filter(Boolean);
  if (new Set(accounts).size !== accounts.length) fail('Each Jira user can be added only once.');
  const projects = arr(s.projects, 200, 'Projects').map((p, i) => {
    const label = p.name || 'Project ' + (i + 1);
    const jiraKey = str(p.jiraKey, 20, label + ' Jira key', false).toUpperCase();
    if (jiraKey && !/^[A-Z][A-Z0-9_]{0,19}$/.test(jiraKey)) fail(label + ': Jira key is not valid.');
    const sizesIn = p.sizes || {};
    return {
      name: str(p.name, 60, 'Project ' + (i + 1) + ' name'), jiraKey, jql: str(p.jql, 1000, label + ' JQL', false),
      due: isoDate(p.due, label + ' due date'), lead: idx(p.lead, people, label + ' lead', true), back: idx(p.back, people, label + ' backup', true),
      sizes: Object.fromEntries(Object.entries(sizesIn).filter(([k, v]) => systems[k] !== undefined && sizeIds.has(v))),
      factors: [...new Set(arr(p.factors || [], 30, 'Factors'))].filter(f => factorIds.has(f)),
      archived: !!p.archived
    };
  });
  const demo = !!s.demo;
  if (prev && prev.demo === demo) {
    for (const [k, label] of [['systems', 'systems'], ['types', 'task types'], ['people', 'people'], ['projects', 'projects']])
      if ((prev[k]?.length ?? 0) > ({ systems, types, people, projects })[k].length) fail('Entries in ' + label + ' cannot be deleted. Archive them instead.');
  }
  return { demo, general, systems, types, sizes, defaultSize, factors, people, projects };
}
