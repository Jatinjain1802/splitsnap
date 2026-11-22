'use strict';
const Database = require('better-sqlite3');
function open(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000');
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES users(id), name TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, name TEXT NOT NULL, UNIQUE(group_id, name));
  CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, description TEXT NOT NULL, amount INTEGER NOT NULL, paid_by INTEGER NOT NULL REFERENCES members(id), split_type TEXT NOT NULL, note TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS splits (expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES members(id), share INTEGER NOT NULL, PRIMARY KEY(expense_id, member_id));
  CREATE TABLE IF NOT EXISTS settlements (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, from_member INTEGER NOT NULL REFERENCES members(id), to_member INTEGER NOT NULL REFERENCES members(id), amount INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS idx_exp_group ON expenses(group_id);
  CREATE INDEX IF NOT EXISTS idx_set_group ON settlements(group_id);
  CREATE INDEX IF NOT EXISTS idx_mem_group ON members(group_id);
  CREATE INDEX IF NOT EXISTS idx_mem_user ON members(user_id);
  CREATE INDEX IF NOT EXISTS idx_sess_exp ON sessions(expires_at);
  `);
  const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  const add = (t, c, def) => { if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  add('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
  for (const [c, d] of [['spent_on', 'TEXT'], ['category', "TEXT DEFAULT 'general'"], ['spec_json', 'TEXT'], ['receipt_file', 'TEXT'], ['receipt_mime', 'TEXT'], ['ocr_text', 'TEXT'], ['edited_by', 'INTEGER'], ['edited_at', 'TEXT']]) add('expenses', c, d);
  db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS invites (token_hash TEXT PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
  `);
  return db;
}
module.exports = { open };
