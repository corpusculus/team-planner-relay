import { defineConfig } from 'vite';

// `vite` (dev) serves both pages with an in-browser backend; `--mode planner|settings` builds one Forge resource.
export default defineConfig(({ mode }) =>
  mode === 'planner' || mode === 'settings'
    ? { root: `static/${mode}`, base: './', build: { outDir: `../../dist/${mode}`, emptyOutDir: true } }
    : { server: { open: '/static/planner/' } }
);
