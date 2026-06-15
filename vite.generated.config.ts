import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

export default defineConfig(() => {
  const id = process.env.GENERATED_VIEW_ID;

  if (!id || !ID_PATTERN.test(id)) {
    throw new Error('GENERATED_VIEW_ID is required and must match /^[a-zA-Z0-9_-]{8,64}$/');
  }

  const appRoot = process.env.GENERATED_APP_ROOT
    ? path.resolve(process.env.GENERATED_APP_ROOT)
    : process.cwd();
  const workspaceRoot = process.env.GENERATED_WORKSPACES_DIR
    ? path.resolve(process.env.GENERATED_WORKSPACES_DIR)
    : path.resolve(appRoot, 'generated-workspaces');
  const distRoot = process.env.GENERATED_DIST_DIR
    ? path.resolve(process.env.GENERATED_DIST_DIR)
    : path.resolve(appRoot, 'generated-dist');

  const workspaceDir = path.resolve(workspaceRoot, id);
  const isPreview = process.env.GENERATED_PREVIEW === '1';
  const outDir = isPreview
    ? path.resolve(distRoot, '.tmp', id, 'preview')
    : path.resolve(distRoot, '.tmp', id);

  return {
    root: workspaceDir,
    base: isPreview ? '/gen-preview/' : `/gen/${id}/`,
    plugins: [react()],
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      minify: true,
    },
  };
});
