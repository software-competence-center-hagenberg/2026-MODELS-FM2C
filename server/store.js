import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';

const DB_PATH = path.join(DATA_DIR, 'generated-views.sqlite');

export class GenerationStore {
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.db = new DatabaseSync(DB_PATH);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS generated_views (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        source_path TEXT NOT NULL,
        dist_path TEXT NOT NULL,
        public_url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS generated_view_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        view_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT,
        size INTEGER NOT NULL,
        content TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(view_id) REFERENCES generated_views(id)
      );
    `);
  }

  createView(view, files = []) {
    const insertView = this.db.prepare(`
      INSERT INTO generated_views (
        id, user_id, title, description, prompt, status, source_path, dist_path,
        public_url, created_at, updated_at, expires_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFile = this.db.prepare(`
      INSERT INTO generated_view_files (view_id, name, type, size, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.db.exec('BEGIN');
    try {
      insertView.run(
        view.id,
        view.user_id ?? null,
        view.title,
        view.description,
        view.prompt,
        view.status,
        view.source_path,
        view.dist_path,
        view.public_url,
        view.created_at,
        view.updated_at,
        view.expires_at ?? null,
        view.error_message ?? null,
      );
      for (const file of files) {
        insertFile.run(view.id, file.name, file.type ?? '', file.size ?? 0, file.content ?? '', view.created_at);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  updateStatus(id, status, errorMessage = null, extra = {}) {
    const now = new Date().toISOString();
    const existing = this.getView(id);
    if (!existing) return null;

    const next = {
      ...existing,
      ...extra,
      status,
      updated_at: now,
      error_message: errorMessage,
    };

    this.db.prepare(`
      UPDATE generated_views
      SET status = ?, updated_at = ?, error_message = ?, title = ?, description = ?, source_path = ?, dist_path = ?, public_url = ?, expires_at = ?
      WHERE id = ?
    `).run(
      next.status,
      next.updated_at,
      next.error_message ?? null,
      next.title,
      next.description,
      next.source_path,
      next.dist_path,
      next.public_url,
      next.expires_at ?? null,
      id,
    );

    return this.getView(id);
  }

  getView(id) {
    return this.db.prepare('SELECT * FROM generated_views WHERE id = ?').get(id) ?? null;
  }

  getFiles(id) {
    return this.db.prepare('SELECT name, type, size, content, created_at FROM generated_view_files WHERE view_id = ? ORDER BY id ASC').all(id);
  }

  listViews() {
    return this.db.prepare(`
      SELECT id, title, description, status, public_url, created_at, updated_at, expires_at, error_message
      FROM generated_views
      WHERE status != 'deleted'
      ORDER BY created_at DESC
      LIMIT 100
    `).all();
  }
}
