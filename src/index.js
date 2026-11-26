// Forge entry point: wires the Relay service to Forge storage and the Jira REST API (as the signed-in user).
import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { createService } from './service.js';
import { UserError } from './shared/model.js';

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

async function requestJira(path, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await api.asUser().requestJira(path, { headers: JSON_HEADERS, ...init });
    if (res.status === 429 && attempt < 3) {
      const wait = Math.min(Number(res.headers.get('Retry-After')) || 2, 10);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new UserError('Jira refused access (HTTP ' + res.status + '). Check that you can see these projects in Jira.');
    if (!res.ok) throw new UserError('Jira request failed (HTTP ' + res.status + '). The last saved plan is unchanged.');
    return res.json();
  }
}

const jira = {
  search: body => requestJira(route`/rest/api/3/search/jql`, { method: 'POST', body: JSON.stringify(body) }),
  // shortcut: first 100 projects only; page through /project/search if a site has more.
  projects: () => requestJira(route`/rest/api/3/project/search?maxResults=100&orderBy=name`),
  users: query => requestJira(route`/rest/api/3/user/search?query=${query}&maxResults=20`),
  /** Issue ids (strings) the calling user may browse. */
  canBrowse: async ids => {
    const allowed = new Set();
    for (let i = 0; i < ids.length; i += 1000) {
      const res = await requestJira(route`/rest/api/3/permissions/check`, { method: 'POST', body: JSON.stringify({ projectPermissions: [{ permissions: ['BROWSE_PROJECTS'], issues: ids.slice(i, i + 1000).map(Number) }] }) });
      for (const p of res.projectPermissions ?? []) for (const id of p.issues ?? []) allowed.add(String(id));
    }
    return allowed;
  },
  myself: () => requestJira(route`/rest/api/3/myself`),
  isAdmin: async () => (await requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`)).permissions?.ADMINISTER?.havePermission === true
};

const service = createService({ store: { get: key => kvs.get(key), set: (key, value) => kvs.set(key, value) }, jira });
const resolver = new Resolver();
for (const name of ['getWorkspace', 'apply', 'getSettings', 'saveSettings', 'refresh', 'importHistory', 'jiraProjects', 'searchUsers'])
  resolver.define(name, ({ payload, context }) => service.handle(name, { accountId: context.accountId, isAdmin: jira.isAdmin }, payload));

export const handler = resolver.getDefinitions();
