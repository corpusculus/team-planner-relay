// One call() for both runtimes: Forge bridge inside Jira, the same service in-browser for `npm run dev`.
export async function call(name, payload = {}) {
  const res = import.meta.env.DEV
    ? await (await import('./local.js')).localCall(name, payload)
    : await (await import('@forge/bridge')).invoke(name, payload);
  if (res?.error) throw Object.assign(new Error(res.error), { code: res.code });
  return res;
}

export async function openIssue(key) {
  if (import.meta.env.DEV) return alert('In Jira this opens ' + key + '.');
  (await import('@forge/bridge')).router.open('/browse/' + encodeURIComponent(key));
}

export const isLocal = import.meta.env.DEV;
