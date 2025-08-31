const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { nanoid } = require('nanoid');
const { init, run, get, all } = require('./db');
const Anthropic = (() => { try { return require('anthropic'); } catch(e) { return null; } })();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// uploads
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });
app.use('/uploads', express.static(UPLOAD_DIR));

// serve static frontend files from project root
const WWW_ROOT = path.resolve(__dirname, '..');
app.use('/', express.static(WWW_ROOT));
app.get('/', (_req, res) => res.sendFile(path.join(WWW_ROOT, 'index.html')));
app.get('/platforma.html', (_req, res) => res.sendFile(path.join(WWW_ROOT, 'platforma.html')));

// ultra-simple token store (in-memory)
const tokens = new Map(); // token -> { id, username, role, grade }

// auth helpers
function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || !tokens.has(token)) return res.status(401).json({ error: 'not_authenticated' });
  req.user = tokens.get(token);
  next();
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  next();
}

// routes
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = await get(`SELECT * FROM users WHERE username=?`, [username]);
  if (!user || user.password !== password) return res.status(401).json({ error: 'invalid_credentials' });
  const token = nanoid(24);
  tokens.set(token, { id: user.id, username: user.username, role: user.role, grade: user.grade || null, group_name: user.group_name || null });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, grade: user.grade || null, group_name: user.group_name || null } });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  for (const [t, u] of tokens) if (u.id === req.user.id) tokens.delete(t);
  res.json({ ok: true });
});

// who am I (validate token)
app.get('/api/auth/me', requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

// admin: create student + enrollments (supports multiple subjects)
app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, grade } = req.body || {};
  let { subject, group_name, enrollments } = req.body || {};
  if (!username || !password || !grade) return res.status(400).json({ error: 'missing_username_password_or_grade' });
  // Normalize enrollments: allow items without grade; we will apply user's grade
  if (Array.isArray(enrollments)) {
    enrollments = enrollments
      .filter(e => e && e.subject)
      .map(e => ({ subject: e.subject, grade: grade, group_name: e.group_name || null }));
  } else if (subject) {
    enrollments = [ { subject, grade, group_name: group_name || null } ];
  } else {
    return res.status(400).json({ error: 'missing_enrollments' });
  }
  try {
    const primary = enrollments[0] || { grade: grade, group_name: null };
    const result = await run(
      `INSERT INTO users (username, password, role, grade, group_name) VALUES (?, ?, 'student', ?, ?)`,
      [username, password, grade || null, primary.group_name || null]
    );
    const userId = result.lastID;
    for (const e of enrollments) {
      // prevent duplicates
      const exists = await get(`SELECT id FROM enrollments WHERE user_id=? AND subject=? AND grade=? AND COALESCE(group_name,'')=COALESCE(?, '')`, [userId, e.subject, e.grade, e.group_name || null]);
      if (!exists) await run(`INSERT INTO enrollments (user_id, subject, grade, group_name) VALUES (?, ?, ?, ?)`, [userId, e.subject, e.grade, e.group_name || null]);
    }
    res.json({ ok: true, id: userId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// admin: add additional enrollment to existing student
app.post('/api/admin/users/:id/enrollments', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { subject, grade, group_name } = req.body || {};
  if (!subject || !grade) return res.status(400).json({ error: 'missing_fields' });
  const user = await get(`SELECT id FROM users WHERE id=? AND role='student'`, [id]);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  // prevent exact-duplicate enrollment
  const existing = await get(`SELECT id FROM enrollments WHERE user_id=? AND subject=? AND grade=? AND COALESCE(group_name,'')=COALESCE(?, '')`, [id, subject, grade, group_name || null]);
  if (existing) return res.status(400).json({ error: 'duplicate_enrollment' });
  await run(`INSERT INTO enrollments (user_id, subject, grade, group_name) VALUES (?, ?, ?, ?)`, [id, subject, grade, group_name || null]);
  res.json({ ok: true });
});

// admin: list students with aggregated enrollments and filter/search
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { q, subject, grade, group_name } = req.query;
  const filters = [];
  const params = [];
  if (q) { filters.push(`u.username LIKE ?`); params.push(`%${q}%`); }
  if (subject) { filters.push(`e.subject=?`); params.push(subject); }
  if (grade) { filters.push(`e.grade=?`); params.push(grade); }
  if (group_name) { filters.push(`e.group_name=?`); params.push(group_name); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = await all(
    `SELECT u.id, u.username, u.grade as default_grade,
            GROUP_CONCAT(e.subject || ':' || e.grade || ':' || COALESCE(e.group_name,''), '|') AS enrollments
     FROM users u
     LEFT JOIN enrollments e ON e.user_id = u.id
     WHERE u.role='student' ${filters.length ? 'AND ' + filters.join(' AND ') : ''}
     GROUP BY u.id, u.username, u.grade
     ORDER BY u.username`,
    params
  );
  res.json(rows.map(r => ({
    id: r.id,
    username: r.username,
    default_grade: r.default_grade,
    enrollments: (r.enrollments ? r.enrollments.split('|').map(s => { const [subject, grade, group] = s.split(':'); return { subject, grade, group_name: group || null }; }) : [])
  })));
});

// admin: delete student (removes enrollments via FK)
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const user = await get(`SELECT id, role FROM users WHERE id=?`, [id]);
  if (!user) return res.status(404).json({ error: 'not_found' });
  if (user.role !== 'student') return res.status(400).json({ error: 'cannot_delete_non_student' });
  await run(`DELETE FROM users WHERE id=?`, [id]);
  res.json({ ok: true });
});

// placeholders for next steps (we’ll implement in Step 2+):
// PDFs, Homeworks, Quizzes, Results, etc.

// ===== PDFs =====
// admin upload PDF (materials) with subject/grade/description
app.post('/api/admin/pdfs', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  const { subject, grade, title, description } = req.body || {};
  if (!subject || !grade || !title || !req.file) return res.status(400).json({ error: 'missing_fields' });
  const filePath = `/uploads/${req.file.filename}`;
  await run(`INSERT INTO pdfs (subject, grade, title, description, file_path) VALUES (?, ?, ?, ?, ?)`, [subject, grade, title, description || null, filePath]);
  res.json({ ok: true, file_path: filePath });
});

// list PDFs for student's enrolled subjects and grade
app.get('/api/pdfs', requireAuth, async (req, res) => {
  // Return materials that match any of the student's enrollments (subject+grade)
  const rows = await all(
    `SELECT DISTINCT p.*
       FROM pdfs p
       JOIN enrollments e
         ON e.user_id = ?
        AND e.subject = p.subject
        AND e.grade = p.grade
       ORDER BY p.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// admin list PDFs (optional grade)
app.get('/api/admin/pdfs', requireAuth, requireAdmin, async (req, res) => {
  const { grade, subject, q } = req.query;
  const filters = [];
  const params = [];
  if (grade) { filters.push('grade=?'); params.push(grade); }
  if (subject) { filters.push('subject=?'); params.push(subject); }
  if (q) { filters.push('title LIKE ?'); params.push('%' + q + '%'); }
  const where = filters.length ? ('WHERE ' + filters.join(' AND ')) : '';
  const rows = await all(`SELECT * FROM pdfs ${where} ORDER BY created_at DESC`, params);
  res.json(rows);
});

// admin delete PDF (also attempt to remove file)
app.delete('/api/admin/pdfs/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const row = await get(`SELECT file_path FROM pdfs WHERE id=?`, [id]);
  if (!row) return res.status(404).json({ error: 'not_found' });
  try {
    const rel = row.file_path.replace(/^\//, '');
    const full = path.join(__dirname, rel);
    if (full.startsWith(UPLOAD_DIR) && fs.existsSync(full)) fs.unlinkSync(full);
  } catch (e) {}
  await run(`DELETE FROM pdfs WHERE id=?`, [id]);
  res.json({ ok: true });
});

// ===== HOMEWORKS =====
// admin create homework (optional pdf) with subject
app.post('/api/admin/homeworks', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  const { subject, grade, group_name, title, description, due_date } = req.body || {};
  if (!subject || !grade || !group_name || !title) return res.status(400).json({ error: 'missing_fields' });
  const pdfPath = req.file ? `/uploads/${req.file.filename}` : null;
  await run(
    `INSERT INTO homeworks (subject, grade, group_name, title, description, due_date, pdf_path) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [subject, grade, group_name, title, description || null, due_date || null, pdfPath]
  );
  res.json({ ok: true, pdf_path: pdfPath });
});

// list homeworks for student's enrolled subjects and group
app.get('/api/homeworks', requireAuth, async (req, res) => {
  const rows = await all(
    `SELECT DISTINCT h.*
       FROM homeworks h
       JOIN enrollments e
         ON e.user_id = ?
        AND e.subject = h.subject
        AND e.grade = h.grade
        AND (h.group_name IS NULL OR h.group_name = e.group_name)
       ORDER BY h.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// admin list homeworks (optional grade)
app.get('/api/admin/homeworks', requireAuth, requireAdmin, async (req, res) => {
  const { grade, group_name, subject, q } = req.query;
  const filters = [];
  const params = [];
  if (grade) { filters.push('grade=?'); params.push(grade); }
  if (group_name) { filters.push('group_name=?'); params.push(group_name); }
  if (subject) { filters.push('subject=?'); params.push(subject); }
  if (q) { filters.push('title LIKE ?'); params.push('%' + q + '%'); }
  const where = filters.length ? ('WHERE ' + filters.join(' AND ')) : '';
  const rows = await all(`SELECT * FROM homeworks ${where} ORDER BY created_at DESC`, params);
  res.json(rows);
});

// admin delete homework
app.delete('/api/admin/homeworks/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const row = await get(`SELECT pdf_path FROM homeworks WHERE id=?`, [id]);
  if (!row) return res.status(404).json({ error: 'not_found' });
  try {
    if (row.pdf_path) {
      const rel = row.pdf_path.replace(/^\//, '');
      const full = path.join(__dirname, rel);
      if (full.startsWith(UPLOAD_DIR) && fs.existsSync(full)) fs.unlinkSync(full);
    }
  } catch (e) {}
  await run(`DELETE FROM homeworks WHERE id=?`, [id]);
  res.json({ ok: true });
});

// ===== QUIZZES =====
// admin create quiz (subject + optional group)
app.post('/api/admin/quizzes', requireAuth, requireAdmin, async (req, res) => {
  const { subject, grade, group_name, title } = req.body || {};
  if (!subject || !grade || !title) return res.status(400).json({ error: 'missing_fields' });
  const result = await run(`INSERT INTO quizzes (subject, grade, group_name, title) VALUES (?, ?, ?, ?)`, [subject, grade, group_name || null, title]);
  res.json({ ok: true, id: result.lastID });
});

// admin add question
app.post('/api/admin/quizzes/:quizId/questions', requireAuth, requireAdmin, async (req, res) => {
  const { quizId } = req.params;
  const { text, options, correctIndex } = req.body || {};
  if (!text || !Array.isArray(options) || options.length < 2 || correctIndex == null) {
    return res.status(400).json({ error: 'invalid_question' });
  }
  await run(
    `INSERT INTO questions (quiz_id, text, options_json, correct_index) VALUES (?, ?, ?, ?)`,
    [quizId, text, JSON.stringify(options), Number(correctIndex)]
  );
  res.json({ ok: true });
});

// list quizzes for student's enrolled subjects and group
app.get('/api/quizzes', requireAuth, async (req, res) => {
  const rows = await all(
    `SELECT DISTINCT q.*
       FROM quizzes q
       JOIN enrollments e
         ON e.user_id = ?
        AND e.subject = q.subject
        AND e.grade = q.grade
        AND (q.group_name IS NULL OR q.group_name = e.group_name)
       ORDER BY q.id DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// student upload homework submission
app.post('/api/homeworks/:id/submit', requireAuth, upload.single('file'), async (req, res) => {
  const { id } = req.params;
  const hw = await get(`SELECT id FROM homeworks WHERE id=?`, [id]);
  if (!hw) return res.status(404).json({ error: 'not_found' });
  if (!req.file) return res.status(400).json({ error: 'missing_file' });
  const filePath = `/uploads/${req.file.filename}`;
  await run(`INSERT INTO hw_submissions (homework_id, user_id, file_path) VALUES (?, ?, ?)`, [id, req.user.id, filePath]);
  res.json({ ok: true, file_path: filePath });
});

// student: my submission status for a homework
app.get('/api/homeworks/:id/submission', requireAuth, async (req, res) => {
  const { id } = req.params;
  const row = await get(`SELECT id, file_path, created_at FROM hw_submissions WHERE homework_id=? AND user_id=?`, [id, req.user.id]);
  res.json(row || null);
});

// admin: list submissions for a homework with user info
app.get('/api/admin/homeworks/:id/submissions', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const rows = await all(
    `SELECT s.id, s.file_path, s.created_at, u.id as user_id, u.username, u.grade
       FROM hw_submissions s
       JOIN users u ON u.id = s.user_id
      WHERE s.homework_id=?
      ORDER BY s.created_at DESC`,
    [id]
  );
  res.json(rows);
});

// admin list quizzes (optional grade)
app.get('/api/admin/quizzes', requireAuth, requireAdmin, async (req, res) => {
  const { grade } = req.query;
  const rows = grade
    ? await all(`SELECT * FROM quizzes WHERE grade=? ORDER BY id DESC`, [grade])
    : await all(`SELECT * FROM quizzes ORDER BY id DESC`);
  res.json(rows);
});

// get quiz with questions
app.get('/api/quizzes/:quizId', requireAuth, async (req, res) => {
  const { quizId } = req.params;
  const quiz = await get(`SELECT * FROM quizzes WHERE id=?`, [quizId]);
  if (!quiz) return res.status(404).json({ error: 'not_found' });
  const questions = await all(`SELECT id, text, options_json FROM questions WHERE quiz_id=?`, [quizId]);
  const normalized = questions.map(q => ({ id: q.id, text: q.text, options: JSON.parse(q.options_json) }));
  res.json({ quiz, questions: normalized });
});

// submit quiz and score
app.post('/api/quizzes/:quizId/submit', requireAuth, async (req, res) => {
  const { quizId } = req.params;
  const { answers } = req.body || {}; // [{questionId, answerIndex}]
  if (!Array.isArray(answers)) return res.status(400).json({ error: 'invalid_answers' });
  const questions = await all(`SELECT id, correct_index FROM questions WHERE quiz_id=?`, [quizId]);
  const answerMap = new Map(answers.map(a => [Number(a.questionId), Number(a.answerIndex)]));
  let score = 0;
  for (const q of questions) {
    if (answerMap.get(q.id) === q.correct_index) score++;
  }
  await run(`INSERT INTO results (user_id, quiz_id, score) VALUES (?, ?, ?)`, [req.user.id, quizId, score]);
  res.json({ ok: true, score, total: questions.length });
});

// admin delete quiz (cascade removes questions, keeps results orphan-safe via FK)
app.delete('/api/admin/quizzes/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const quiz = await get(`SELECT id FROM quizzes WHERE id=?`, [id]);
  if (!quiz) return res.status(404).json({ error: 'not_found' });
  await run(`DELETE FROM quizzes WHERE id=?`, [id]);
  res.json({ ok: true });
});

// admin: delete ALL quizzes (and cascade questions/results)
app.delete('/api/admin/quizzes', requireAuth, requireAdmin, async (_req, res) => {
  await run(`DELETE FROM quizzes`);
  res.json({ ok: true });
});

// ===== RESULTS =====
// student: my results
app.get('/api/my/results', requireAuth, async (req, res) => {
  const rows = await all(
    `SELECT r.id, r.quiz_id, r.score, r.created_at, q.title
     FROM results r JOIN quizzes q ON q.id=r.quiz_id
     WHERE r.user_id=? ORDER BY r.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// admin: results by grade
app.get('/api/admin/results', requireAuth, requireAdmin, async (req, res) => {
  const grade = req.query.grade;
  if (!grade) return res.status(400).json({ error: 'missing_grade' });
  const rows = await all(
    `SELECT r.id, u.username, u.grade, q.title, r.score, r.created_at
     FROM results r
     JOIN users u ON u.id=r.user_id
     JOIN quizzes q ON q.id=r.quiz_id
     WHERE u.grade=?
     ORDER BY r.created_at DESC`,
    [grade]
  );
  res.json(rows);
});

// ===== REPORTS =====
// admin create weekly report for a student
app.post('/api/admin/reports', requireAuth, requireAdmin, async (req, res) => {
  const { user_id, date, prezenta, lectia, tema, atentie, nota_test, observatii } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'missing_user_id' });
  await run(
    `INSERT INTO reports (user_id, date, prezenta, lectia, tema, atentie, nota_test, observatii) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [user_id, date || null, prezenta || null, lectia || null, tema || null, atentie || null, nota_test || null, observatii || null]
  );
  res.json({ ok: true });
});

// admin list reports for a grade or user
app.get('/api/admin/reports', requireAuth, requireAdmin, async (req, res) => {
  const { grade, user_id } = req.query;
  if (user_id) {
    const rows = await all(`SELECT r.*, u.username FROM reports r JOIN users u ON u.id=r.user_id WHERE r.user_id=? ORDER BY r.date DESC, r.created_at DESC`, [user_id]);
    return res.json(rows);
  }
  if (grade) {
    const rows = await all(`SELECT r.*, u.username FROM reports r JOIN users u ON u.id=r.user_id WHERE u.grade=? ORDER BY r.date DESC, r.created_at DESC`, [grade]);
    return res.json(rows);
  }
  // If no grade or user is provided, return all reports for all students
  const rows = await all(`SELECT r.*, u.username FROM reports r JOIN users u ON u.id=r.user_id ORDER BY r.date DESC, r.created_at DESC`);
  res.json(rows);
});

// admin delete a weekly report
app.delete('/api/admin/reports/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const row = await get(`SELECT id FROM reports WHERE id=?`, [id]);
  if (!row) return res.status(404).json({ error: 'not_found' });
  await run(`DELETE FROM reports WHERE id=?`, [id]);
  res.json({ ok: true });
});

// student: my reports
app.get('/api/my/reports', requireAuth, async (req, res) => {
  const rows = await all(
    `SELECT id, date, prezenta, lectia, tema, atentie, nota_test, observatii, created_at
     FROM reports WHERE user_id=? ORDER BY date DESC, created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// ===== DAILY LESSONS =====
// admin upload lesson pdf (subject/grade/group) with optional description
app.post('/api/admin/daily-lessons', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  const { subject, grade, group_name, title, description, date } = req.body || {};
  if (!subject || !grade || !group_name || !title || !req.file) return res.status(400).json({ error: 'missing_fields' });
  const filePath = `/uploads/${req.file.filename}`;
  await run(`INSERT INTO daily_lessons (subject, grade, group_name, title, description, file_path, date) VALUES (?, ?, ?, ?, ?, ?, ?)`, [subject, grade, group_name, title, description || null, filePath, date || null]);
  res.json({ ok: true, file_path: filePath });
});

// student: list lessons for subjects and groups the student is enrolled in
app.get('/api/daily-lessons', requireAuth, async (req, res) => {
  const rows = await all(
    `SELECT dl.*
     FROM daily_lessons dl
     JOIN enrollments e
       ON e.user_id = ?
      AND e.subject = dl.subject
      AND e.grade = dl.grade
      AND e.group_name = dl.group_name
     ORDER BY COALESCE(dl.date, dl.created_at) DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// admin list lessons (optional by group)
app.get('/api/admin/daily-lessons', requireAuth, requireAdmin, async (req, res) => {
  const { group_name, grade, subject, q } = req.query;
  const filters = [];
  const params = [];
  if (group_name) { filters.push('group_name=?'); params.push(group_name); }
  if (grade) { filters.push('grade=?'); params.push(grade); }
  if (subject) { filters.push('subject=?'); params.push(subject); }
  if (q) { filters.push('title LIKE ?'); params.push('%' + q + '%'); }
  const where = filters.length ? ('WHERE ' + filters.join(' AND ')) : '';
  const rows = await all(`SELECT * FROM daily_lessons ${where} ORDER BY COALESCE(date, created_at) DESC`, params);
  res.json(rows);
});

// admin delete a daily lesson (and its file)
app.delete('/api/admin/daily-lessons/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const row = await get(`SELECT file_path FROM daily_lessons WHERE id=?`, [id]);
  if (!row) return res.status(404).json({ error: 'not_found' });
  try {
    if (row.file_path) {
      const rel = row.file_path.replace(/^\//, '');
      const full = path.join(__dirname, rel);
      const UPLOAD_DIR = path.join(__dirname, 'uploads');
      if (full.startsWith(UPLOAD_DIR) && fs.existsSync(full)) fs.unlinkSync(full);
    }
  } catch (e) {}
  await run(`DELETE FROM daily_lessons WHERE id=?`, [id]);
  res.json({ ok: true });
});

init().then(() => {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
});

// ===== AI QUIZ GENERATION (ADMIN) =====
app.post('/api/admin/ai-quiz', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!Anthropic) return res.status(500).json({ error: 'anthropic_sdk_missing' });
    const { subject, grade, group_name, topic, count } = req.body || {};
    if (!subject || !grade) return res.status(400).json({ error: 'missing_fields' });
    const num = Math.max(1, Math.min(20, Number(count || 5)));

    const client = new Anthropic.Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'missing_anthropic_api_key' });

    const system = 'You generate Romanian school multiple-choice quizzes. Return ONLY valid JSON. Do not include any extra text.';
    const userPrompt = `Creează un test MCQ pentru:\n- Subiect: ${subject}\n- Clasa: ${grade}\n- Grup: ${group_name || '-'}\n- Topic/competențe: ${topic || 'curriculum standard'}\n- Număr întrebări: ${num}\n\nCerințe:\n- DOAR JSON valid conform schemei:\n{\n  "title": "string",\n  "questions": [\n    {\n      "text": "string",\n      "options": ["string", "string", "string", "string"],\n      "correctIndex": 0\n    }\n  ]\n}\n- Limbaj adecvat clasei. Distractori plauzibili. Un singur răspuns corect.`;

    const msg = await client.messages.create({
      model: 'claude-3-5-sonnet-20240620',
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: userPrompt }],
      response_format: { type: 'json_object' }
    });

    const text = msg?.content?.[0]?.text || '{}';
    let data;
    try { data = JSON.parse(text); } catch (e) { return res.status(500).json({ error: 'invalid_ai_json' }); }
    if (!data || !Array.isArray(data.questions) || !data.questions.length) return res.status(500).json({ error: 'ai_empty' });

    const title = String(data.title || `Quiz AI — ${subject} ${grade}`).slice(0, 200);
    const result = await run(`INSERT INTO quizzes (subject, grade, group_name, title) VALUES (?, ?, ?, ?)`, [subject, grade, group_name || null, title]);
    const quizId = result.lastID;
    for (const q of data.questions) {
      const options = Array.isArray(q.options) ? q.options.slice(0, 10) : [];
      const correctIndex = Number(q.correctIndex || 0);
      await run(
        `INSERT INTO questions (quiz_id, text, options_json, correct_index) VALUES (?, ?, ?, ?)`,
        [quizId, String(q.text || '').slice(0, 1000), JSON.stringify(options), correctIndex]
      );
    }
    res.json({ ok: true, id: quizId });
  } catch (e) {
    res.status(500).json({ error: 'ai_quiz_failed', detail: String(e.message || e) });
  }
});