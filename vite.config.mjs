import { defineConfig } from 'vite';

// `vite` (dev) serves both pages with an in-browser backend; `--mode planner|settings|issue` builds one Forge resource.
export default defineConfig(({ mode }) =>
  ['planner', 'settings', 'issue'].includes(mode)
    ? { root: `static/${mode}`, base: './', build: { outDir: `../../dist/${mode}`, emptyOutDir: true } }
    : { server: { open: '/static/planner/' } }
);
