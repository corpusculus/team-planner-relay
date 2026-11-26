# Relay on Jira — v1 design (approved 2026-11-26)

- Forge app: `jira:globalPage` planner + `jira:adminPage` settings, Custom UI (existing vanilla JS), resolver backend, Forge KVS.
- Jira read-only as the signed-in user; refresh pages through all results before saving. Planner data keyed by Jira issue id.
- Configurable task types: system, base hours, buffer, duration source (Relay estimate / Jira original estimate / story points × h), Jira match rules (issue types, components, labels).
- Estimation: history percentile (P70 estimate, P90 buffer, ≥3 samples, 12 months, most specific level first, normalised by size×complexity multiplier), else type default × system size (per project+system) × complexity factors (per project or Jira label).
- Units: hours, scheduled in configurable slots (default 4h of an 8h day).
- Roles from settings (member / team manager / PM), enforced in the backend; PM responses redacted.
- Changes: client previews with the shared model; backend re-applies with a revision check and op ids.
- Demo mode with fictional data until an admin switches to live.
