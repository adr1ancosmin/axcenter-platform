const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, 'data.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function init() {
  await run('PRAGMA foreign_keys = ON');

  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,          -- plain text for simplicity only
    role TEXT NOT NULL,              -- 'admin' | 'student'
    grade TEXT                       -- e.g. 'clasa-5', nullable for admin
  )`);

  // Add group_name column if missing
  try {
    const cols = await all(`PRAGMA table_info(users)`);
    const hasGroup = cols.some(c => c.name === 'group_name');
    if (!hasGroup) {
      await run(`ALTER TABLE users ADD COLUMN group_name TEXT`);
    }
  } catch (e) {
    // ignore
  }

  // Per-subject enrollment for each student
  await run(`CREATE TABLE IF NOT EXISTS enrollments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    subject TEXT NOT NULL,          -- ex: 'romana' | 'matematica' | 'engleza'
    grade TEXT NOT NULL,            -- ex: 'clasa-5'
    group_name TEXT,                -- ex: 'grupa-A' or '1', optional
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // Helpful indexes for fast search/filtering in admin
  await run(`CREATE INDEX IF NOT EXISTS idx_enrollments_user ON enrollments(user_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_enrollments_subject_grade_group ON enrollments(subject, grade, group_name)`);

  await run(`CREATE TABLE IF NOT EXISTS pdfs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT,                   -- optional for backward compat
    grade TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    file_path TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // add missing columns to pdfs
  try {
    const cols = await all(`PRAGMA table_info(pdfs)`);
    const needSubject = !cols.some(c => c.name === 'subject');
    const needDescription = !cols.some(c => c.name === 'description');
    if (needSubject) await run(`ALTER TABLE pdfs ADD COLUMN subject TEXT`);
    if (needDescription) await run(`ALTER TABLE pdfs ADD COLUMN description TEXT`);
  } catch (e) { /* ignore */ }

  await run(`CREATE TABLE IF NOT EXISTS homeworks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT,                  -- optional for backward compat
    grade TEXT NOT NULL,
    group_name TEXT,
    title TEXT NOT NULL,
    description TEXT,
    due_date TEXT,
    pdf_path TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Add group_name to homeworks if missing (for per-group assignments)
  try {
    const cols = await all(`PRAGMA table_info(homeworks)`);
    if (!cols.some(c => c.name === 'group_name')) await run(`ALTER TABLE homeworks ADD COLUMN group_name TEXT`);
    if (!cols.some(c => c.name === 'subject')) await run(`ALTER TABLE homeworks ADD COLUMN subject TEXT`);
  } catch (e) { /* ignore */ }

  await run(`CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT,                  -- optional for backward compat
    grade TEXT NOT NULL,
    group_name TEXT,
    title TEXT NOT NULL
  )`);

  try {
    const cols = await all(`PRAGMA table_info(quizzes)`);
    if (!cols.some(c => c.name === 'subject')) await run(`ALTER TABLE quizzes ADD COLUMN subject TEXT`);
    if (!cols.some(c => c.name === 'group_name')) await run(`ALTER TABLE quizzes ADD COLUMN group_name TEXT`);
  } catch (e) { /* ignore */ }

  await run(`CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    options_json TEXT NOT NULL,      -- JSON string array
    correct_index INTEGER NOT NULL,
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    quiz_id INTEGER NOT NULL,
    score INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
  )`);

  // Student homework submissions
  await run(`CREATE TABLE IF NOT EXISTS hw_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    homework_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (homework_id) REFERENCES homeworks(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // Weekly reports for parents
  await run(`CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT,
    prezenta TEXT,
    lectia TEXT,
    tema TEXT,
    atentie TEXT,
    nota_test INTEGER,
    observatii TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // Daily lesson PDFs by grade and group
  await run(`CREATE TABLE IF NOT EXISTS daily_lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT,                   -- optional for backward compat
    grade TEXT NOT NULL,
    group_name TEXT,
    title TEXT NOT NULL,
    description TEXT,
    file_path TEXT NOT NULL,
    date TEXT,                       -- optional specific date
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  try {
    const cols = await all(`PRAGMA table_info(daily_lessons)`);
    if (!cols.some(c => c.name === 'subject')) await run(`ALTER TABLE daily_lessons ADD COLUMN subject TEXT`);
    if (!cols.some(c => c.name === 'description')) await run(`ALTER TABLE daily_lessons ADD COLUMN description TEXT`);
  } catch (e) { /* ignore */ }

  // Seed default admin if missing
  const existing = await get(`SELECT id FROM users WHERE role='admin' LIMIT 1`);
  if (!existing) {
    await run(
      `INSERT INTO users (username, password, role) VALUES (?, ?, 'admin')`,
      ['admin', 'admin123']
    );
    console.log('Created default admin: username="admin", password="admin123"');
  }
}

module.exports = { db, run, get, all, init }; 