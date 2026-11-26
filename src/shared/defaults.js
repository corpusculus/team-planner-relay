// Default configuration and the fictional demo portfolio (ported from the original team-planner.html).
import { calendar, emptyState } from './model.js';
import { multiplier } from './estimate.js';

export const GENERAL = {
  workdayHours: 8, slotHours: 4, dayStartHour: 8, planStart: '2026-11-30',
  estimatePercentile: 70, bufferPercentile: 90, minSamples: 3, historyMonths: 12,
  storyPointsField: 'customfield_10016', blockLinkType: 'Blocks', internalIssue: ''
};
export const SIZES = [
  { id: 'S', name: 'Small', multiplier: 0.75 },
  { id: 'M', name: 'Medium', multiplier: 1 },
  { id: 'L', name: 'Large', multiplier: 1.5 },
  { id: 'XL', name: 'Extra large', multiplier: 2.25 }
];
export const FACTORS = [
  { id: 'data', name: 'Data transfer', multiplier: 1.3, label: 'data-transfer' },
  { id: 'vpn', name: 'VPN / remote access', multiplier: 1.2, label: 'vpn' },
  { id: 'site', name: 'Customer site', multiplier: 1.25, label: 'on-site' }
];
const SYSTEMS = ['Controls', 'Integration', 'Data', 'Interface', 'Monitoring', 'Access'];
const TYPE_NAMES = ['Validate control loop', 'Test integration', 'Verify data feed', 'Review interface', 'Check alerts', 'Verify access'];
const TYPE_HOURS = [[16, 8], [16, 8], [16, 16], [16, 8], [8, 8], [8, 8]];

const type = (name, system, baseHours, bufferHours, rules = {}) => ({
  name, system, baseHours, bufferHours, source: 'relay', hoursPerPoint: 4, issueTypes: '', components: '', labels: '', archived: false, ...rules
});
const defaultTypes = () => [
  ...TYPE_NAMES.map((n, s) => type(n, s, ...TYPE_HOURS[s], { issueTypes: 'Task, Story', components: SYSTEMS[s] })),
  type('Custom activity', 0, 16, 8)
];

/** Settings for a real Jira site: keeps the estimation catalogue, starts with no people or projects. */
export function liveSettings(from) {
  const monday = new Date(); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return {
    demo: false,
    general: { ...(from?.general ?? GENERAL), planStart: monday.toISOString().slice(0, 10) },
    systems: from?.systems ?? [...SYSTEMS], types: from?.types ?? defaultTypes(),
    sizes: from?.sizes ?? SIZES, defaultSize: from?.defaultSize ?? 'M', factors: from?.factors ?? FACTORS,
    holidays: from?.holidays ?? [], projects: [], people: []
  };
}

const NAMES = ['Atlas', 'Beacon', 'Cedar', 'Delta', 'Ember', 'Fjord', 'Grove', 'Harbor', 'Indigo', 'Juniper', 'Kestrel', 'Lumen', 'Meridian', 'Nova', 'Orion'];
const LEADS = [0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4], BACKS = [4, 0, 1, 2, 0, 1, null, 4, 1, null, 4, 2, null, 1, 3];
const DUE = [3, 4, 3, 5, 4, 7, 8, 8, 9, 10, 12, 13, 13, 14, 15];
const PEOPLE = [
  ['Ana Silva', 'Controls engineer', [0, 1, 4]], ['Ben Cole', 'Integration engineer', [1, 2, 5]], ['Cara Li', 'Data engineer', [2, 4, 3]],
  ['Dev Shah', 'Interface engineer', [3, 5, 1]], ['Eva Ruiz', 'Systems engineer', [4, 0, 5]]
];

export function sampleSettings() {
  const cal = calendar(GENERAL), sizeCycle = ['M', 'L', 'S', 'XL', 'M'];
  return {
    demo: true, general: { ...GENERAL }, systems: [...SYSTEMS], types: defaultTypes(), sizes: SIZES, defaultSize: 'M', factors: FACTORS,
    holidays: ['2026-12-24', '2026-12-25', '2026-12-31', '2027-01-01'],
    // Dev works Monday to Thursday, to show part-time planning.
    people: PEOPLE.map(([name, role, skills], i) => ({ name, role, skills, access: 'member', accountId: null, pmProjects: [], archived: false, days: i === 3 ? [0, 1, 2, 3] : [0, 1, 2, 3, 4], hoursPerDay: 8 })),
    projects: NAMES.map((name, i) => ({
      name, lead: LEADS[i], back: BACKS[i], due: cal.isoOfDay(DUE[i]), jiraKey: '', jql: '', archived: false,
      sizes: Object.fromEntries(SYSTEMS.map((_, s) => [s, sizeCycle[(i + s) % 5]])),
      factors: [i % 4 === 1 ? 'vpn' : null, i % 5 === 2 ? 'data' : null].filter(Boolean)
    }))
  };
}

/** Demo plan in slots (day values from the original HTML × slots per day). */
export function sampleState(settings) {
  const spd = settings.general.workdayHours / settings.general.slotHours, d = n => n * spd;
  const tasks = [];
  settings.projects.forEach((p, i) => {
    const [a, b] = settings.people[p.lead].skills;
    tasks.push(
      { id: 'a' + i, p: i, s: a, type: a, name: TYPE_NAMES[a], work: d(i % 3 === 1 ? 3 : 2), buffer: d(a === 2 ? 2 : 1), rank: i * 2, deps: [], ready: 0, source: 'Sample estimate' },
      { id: 'b' + i, p: i, s: b, type: b, name: TYPE_NAMES[b], work: d(1 + (i % 2)), buffer: d(b === 2 ? 2 : 1), rank: i * 2 + 1, deps: ['a' + i], ready: 0, source: 'Sample estimate' }
    );
  });
  Object.assign(tasks[0], { name: 'Update test system', work: d(1), buffer: d(1) });
  tasks.find(t => t.id === 'a2').started = { who: 2, start: 0 };
  // Jira assignees in the demo: one agrees with the plan, one differs, to show the warning.
  tasks.find(t => t.id === 'a0').assignee = { id: null, name: 'Ana Silva' };
  tasks.find(t => t.id === 'a1').assignee = { id: null, name: 'Ana Silva' };
  tasks.find(t => t.id === 'a3').wait = { who: 3, reason: 'Customer to enable access to the test environment.', shared: true };
  // Fictional finished work so the history-based estimator has something to learn from.
  const completed = [];
  settings.projects.forEach((p, i) => [settings.people[p.lead].skills[0], settings.people[p.lead].skills[1]].forEach((s, k) => {
    const m = multiplier(settings, i, s).value, base = settings.types[s].baseHours;
    for (let n = 0; n < 3; n++)
      completed.push({ type: s, p: i, s, hours: Math.round(base * m * (0.8 + ((i * 7 + s * 3 + n * 5 + k) % 9) / 10)), mult: m, at: '2026-' + String(3 + ((i + n) % 8)).padStart(2, '0') + '-15', source: 'sample' });
  }));
  return {
    ...emptyState(settings), tasks, completed,
    logs: [
      { id: 'sample1', who: 2, task: 'a2', p: 2, date: '2026-11-30', minutes: 225, note: 'Checked the incoming records.' },
      { id: 'sample2', who: 2, task: null, p: null, date: '2026-11-30', minutes: 30, note: 'Internal knowledge sharing.' },
      { id: 'sample3', who: 0, task: 'a0', p: 0, date: '2026-11-30', minutes: 180, note: '' },
      { id: 'sample4', who: 1, task: 'a1', p: 1, date: '2026-11-30', minutes: 105, note: '' }
    ],
    leave: [{ who: 4, start: d(3), len: d(2) }],
    privateTime: settings.people.map((_, who) => ({ id: 'f' + who, who, start: d([4, 3, 4, 2, 2][who]), len: d(1), name: ['Design review notes', 'Tooling improvements', 'Data quality checks', 'Interface research', 'Maintenance backlog'][who] })),
    notes: { 0: 'The customer would like to attend the integration test. Timing is still open.' }
  };
}
