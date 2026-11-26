// Forge entry point: wires the Relay service to Forge storage and the Jira REST API.
import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { createService } from './service.js';
import { UserError } from './shared/model.js';

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

/** Jira client acting as the signed-in user (`api.asUser`) or as the app itself (`api.asApp`, for scheduled jobs). */
function makeJira(as) {
  async function request(path, init = {}) {
    for (let attempt = 1; ; attempt++) {
      const res = await as().requestJira(path, { headers: JSON_HEADERS, ...init });
      if (res.status === 429 && attempt < 3) {
        const wait = Math.min(Number(res.headers.get('Retry-After')) || 2, 10);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new UserError('Jira refused access (HTTP ' + res.status + '). Check your Jira permissions for this project.');
      if (!res.ok) throw new UserError('Jira request failed (HTTP ' + res.status + '). Nothing was changed in Relay.');
      return res.status === 204 ? null : res.json();
    }
  }
  const send = (method, body) => ({ method, body: JSON.stringify(body) });
  return {
    search: body => request(route`/rest/api/3/search/jql`, send('POST', body)),
    // shortcut: first 100 projects only; page through /project/search if a site has more.
    projects: () => request(route`/rest/api/3/project/search?maxResults=100&orderBy=name`),
    users: query => request(route`/rest/api/3/user/search?query=${query}&maxResults=20`),
    myself: () => request(route`/rest/api/3/myself`),
    isAdmin: async () => (await request(route`/rest/api/3/mypermissions?permissions=ADMINISTER`)).permissions?.ADMINISTER?.havePermission === true,
    /** Issue ids (strings) the caller may browse. */
    canBrowse: async ids => {
      const allowed = new Set();
      for (let i = 0; i < ids.length; i += 1000) {
        const res = await request(route`/rest/api/3/permissions/check`, send('POST', { projectPermissions: [{ permissions: ['BROWSE_PROJECTS'], issues: ids.slice(i, i + 1000).map(Number) }] }));
        for (const p of res.projectPermissions ?? []) for (const id of p.issues ?? []) allowed.add(String(id));
      }
      return allowed;
    },
    worklogs: async (issueId, after, before) => (await request(route`/rest/api/3/issue/${issueId}/worklog?startedAfter=${after}&startedBefore=${before}&maxResults=5000`)).worklogs ?? [],
    addWorklog: (issue, body) => request(route`/rest/api/3/issue/${issue}/worklog?notifyUsers=false`, send('POST', body)),
    updateWorklog: (issue, id, body) => request(route`/rest/api/3/issue/${issue}/worklog/${id}?notifyUsers=false`, send('PUT', body)),
    deleteWorklog: (issue, id) => request(route`/rest/api/3/issue/${issue}/worklog/${id}?notifyUsers=false`, { method: 'DELETE' }),
    updateIssue: (issue, fields) => request(route`/rest/api/3/issue/${issue}`, send('PUT', { fields }))
  };
}

const store = {
  get: key => kvs.get(key),
  set: (key, value) => kvs.set(key, value),
  // Create-only write: false when another save already took this key. Short expiry so a failed save never blocks for long.
  claim: key => kvs.set(key, 1, { keyPolicy: 'FAIL_IF_EXISTS', ttl: { value: 60, unit: 'SECONDS' } }).then(() => true, () => false)
};

const userJira = makeJira(() => api.asUser());
const service = createService({ store, jira: userJira });
const appService = createService({ store, jira: makeJira(() => api.asApp()) });

const resolver = new Resolver();
for (const name of ['getWorkspace', 'apply', 'pushToJira', 'getSettings', 'saveSettings', 'forgetPerson', 'refresh', 'importHistory', 'jiraProjects', 'searchUsers'])
  resolver.define(name, ({ payload, context }) => service.handle(name, { accountId: context.accountId, isAdmin: userJira.isAdmin }, payload));

export const handler = resolver.getDefinitions();

/** Scheduled trigger (hourly). */
export async function autoRefresh() {
  try {
    return await appService.autoRefresh();
  } catch (e) {
    console.error('autoRefresh', e);
    return { error: true };
  }
}
