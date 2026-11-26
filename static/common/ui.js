// Small DOM helpers shared by the planner and settings pages.
export const $ = id => document.getElementById(id);
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const options = (items, selected) => items.map(([v, label]) => '<option value="' + esc(v) + '"' + (String(v) === String(selected ?? '') ? ' selected' : '') + '>' + esc(label) + '</option>').join('');
export function modal(title, html) {
  $('dialogTitle').textContent = title;
  $('body').innerHTML = html;
  if (!$('modal').open) $('modal').showModal();
  $('modal').scrollTop = 0;
}
