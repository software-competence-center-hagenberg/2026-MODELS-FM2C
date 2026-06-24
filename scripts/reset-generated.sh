#!/bin/sh
# reset-generated.sh — wipe ALL generated SPL configurator sites.
# Run from the host (the docker-compose project dir). Connects to the running
# api container, deletes every generated workspace, dist build, preview dir
# and marks every DB row as deleted. Done.
#
# Usage:
#   ./scripts/reset-generated.sh            # delete everything
#   ./scripts/reset-generated.sh --dry-run   # show what would go, delete nothing

set -eu

cd "$(dirname "$0")/.."   # repo root, where docker-compose.yml lives

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# ponytail: `docker compose exec api` is the only entry point we need — no
# host-side node, no volume mounts to juggle. The api container already has
# node + node:sqlite and the same GENERATED_*_DIR env the app uses.
docker compose exec -T -e CLEANUP_DRY_RUN="$DRY_RUN" api node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dryRun = process.env.CLEANUP_DRY_RUN === '1';
const wsDir = process.env.GENERATED_WORKSPACES_DIR || '/app/generated-workspaces';
const distDir = process.env.GENERATED_DIST_DIR || '/app/generated-dist';
const dataDir = process.env.GENERATED_DATA_DIR || '/app/data';

const rm = (p) => { if (!fs.existsSync(p)) return; if (dryRun) { console.log('[dry] rm -rf ' + p); return; } fs.rmSync(p, { recursive: true, force: true }); };
const wipeDir = (root) => {
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue; // keep .tmp parent, handled below
    rm(path.join(root, e.name));
    n++;
  }
  return n;
};
const clearTmp = (root) => {
  const tmp = path.join(root, '.tmp');
  if (!fs.existsSync(tmp)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(tmp, { withFileTypes: true }))
    if (e.isDirectory()) { rm(path.join(tmp, e.name)); n++; }
  return n;
};

let ws = wipeDir(wsDir), dist = wipeDir(distDir), tmp = clearTmp(distDir);

// DB: mark every generated_view row deleted (keeps history, stops the API
// from listing them). If you'd rather flatten entirely, drop the whole file.
const dbPath = path.join(dataDir, 'generated-views.sqlite');
let rows = 0, dropped = 0;
if (fs.existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout=5000');
  rows = db.prepare("SELECT COUNT(*) c FROM generated_views WHERE status!='deleted'").get().c;
  if (!dryRun && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generated_views'").get()) {
    const now = new Date().toISOString();
    db.prepare("UPDATE generated_views SET status='deleted', updated_at=? WHERE status!='deleted'").run(now);
  }
  db.close();
}

console.log((dryRun ? '[dry] ' : '') + 'wiped ' + ws + ' workspace(s), ' + dist + ' dist build(s), ' + tmp + ' preview(s); ' + rows + ' view row(s) marked deleted.');
NODE