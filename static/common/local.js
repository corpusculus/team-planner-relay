// Local preview backend: the real service with browser storage and no Jira.
import { createService } from '../../src/service.js';

const store = {
  get: async key => JSON.parse(localStorage.getItem('relay.local.' + key) ?? 'null') ?? undefined,
  set: async (key, value) => localStorage.setItem('relay.local.' + key, JSON.stringify(value))
};
const service = createService({ store, jira: null });
const ctx = { accountId: 'local-preview', isAdmin: async () => true };

export const localCall = (name, payload) => service.handle(name, ctx, structuredClone(payload));
