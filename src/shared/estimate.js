// Task estimation: Jira value, history percentile, or type default × size × complexity.

export const toSlots = (hours, slotHours) => Math.max(0, Math.ceil(hours / slotHours - 1e-9));

const lower = list => (list || []).map(x => String(x).toLowerCase());

/** Size × complexity multiplier for a project/system, plus factors switched on by Jira labels. */
export function multiplier(settings, p, s, labels = []) {
  const project = settings.projects[p];
  const sizeId = project?.sizes?.[s] ?? settings.defaultSize;
  const size = settings.sizes.find(z => z.id === sizeId);
  const on = new Set(project?.factors || []);
  const issueLabels = lower(labels);
  for (const f of settings.factors) if (f.label && issueLabels.includes(f.label.toLowerCase())) on.add(f.id);
  const factors = settings.factors.filter(f => on.has(f.id));
  return {
    value: factors.reduce((m, f) => m * f.multiplier, size?.multiplier ?? 1),
    parts: [...(size && size.multiplier !== 1 ? [size.name + ' system'] : []), ...factors.map(f => f.name)]
  };
}

/** Linear-interpolated percentile (pct 0–100) of a non-empty list. */
export function percentile(values, pct) {
  const v = [...values].sort((a, b) => a - b), i = (pct / 100) * (v.length - 1), lo = Math.floor(i);
  return lo + 1 < v.length ? v[lo] + (v[lo + 1] - v[lo]) * (i - lo) : v[lo];
}

/**
 * Returns { hours, buffer, source } for a task.
 * History records are { type, p, s, hours, mult, at }. They are normalised by the multiplier that applied
 * when they finished, then scaled by today's multiplier, so a small system's history still informs a large one.
 */
export function estimate(settings, { type, p, s, labels = [], originalEstimateSec, storyPoints }, completed = [], todayIso) {
  const T = settings.types[type], g = settings.general;
  const m = multiplier(settings, p, s, labels);
  if (T.source === 'jira-estimate' && originalEstimateSec > 0)
    return { hours: originalEstimateSec / 3600, buffer: T.bufferHours, source: 'Jira original estimate' };
  if (T.source === 'story-points' && storyPoints > 0)
    return { hours: storyPoints * T.hoursPerPoint, buffer: T.bufferHours, source: storyPoints + ' story points × ' + T.hoursPerPoint + 'h' };

  const since = Date.parse(todayIso) - g.historyMonths * 30.44 * 86400000;
  const recent = completed.filter(h => h.type === type && h.hours > 0 && h.mult > 0 && Date.parse(h.at) >= since);
  const levels = [
    [h => h.p === p && h.s === s, 'same project and system'],
    [h => h.s === s, 'same system'],
    [() => true, 'same task type']
  ];
  for (const [match, label] of levels) {
    const sample = recent.filter(match).map(h => h.hours / h.mult);
    if (sample.length < g.minSamples) continue;
    const hours = percentile(sample, g.estimatePercentile) * m.value;
    const high = percentile(sample, g.bufferPercentile) * m.value;
    return { hours, buffer: Math.max(0, high - hours), source: 'History · ' + sample.length + ' tasks, ' + label + ' · P' + g.estimatePercentile };
  }
  return {
    hours: T.baseHours * m.value,
    buffer: T.bufferHours * m.value,
    source: m.parts.length ? 'Type default × ' + Math.round(m.value * 100) / 100 + ' (' + m.parts.join(', ') + ')' : 'Type default'
  };
}
