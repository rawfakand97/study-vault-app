const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { pool, initDb } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('JWT_SECRET is required'); process.exit(1); }

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

/* ---------- helpers ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function detectType(link) {
  const host = new URL(link).hostname.replace(/^www\./, '');
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) return 'yt';
  if (/^(drive|docs)\.google\.com$/.test(host)) return 'drive';
  return 'link';
}

function cleanLink(raw) {
  try {
    const u = new URL(String(raw).trim());
    return ['http:', 'https:'].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}

const signToken = u => jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '7d' });
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });

async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return bad(res, 'Please log in.', 401);
  try {
    const { id } = jwt.verify(h.slice(7), JWT_SECRET);
    const { rows } = await pool.query('SELECT id,name,email,role FROM users WHERE id=$1', [id]);
    if (!rows[0]) return bad(res, 'Session expired. Please log in again.', 401);
    req.user = rows[0];
    next();
  } catch {
    return bad(res, 'Session expired. Please log in again.', 401);
  }
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : bad(res, 'You do not have permission to do that.', 403);

async function canManage(user, courseId) {
  if (user.role === 'chairman') return true;
  if (user.role !== 'teacher') return false;
  const { rows } = await pool.query(
    'SELECT 1 FROM assignments WHERE course_id=$1 AND teacher_id=$2', [courseId, user.id]);
  return rows.length > 0;
}

/* ---------- health ---------- */
app.get('/healthz', (req, res) => res.send('ok'));

/* ---------- auth ---------- */
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' } });

// NOTE: wrong credentials return 400 (not 401) because the frontend logs out on any 401.
app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name || name.length > 100) return bad(res, 'Please enter your name.');
  if (!EMAIL_RE.test(email)) return bad(res, 'Please enter a valid email.');
  if (password.length < 6) return bad(res, 'Password must be at least 6 characters.');

  const exists = await pool.query('SELECT 1 FROM users WHERE email=$1', [email]);
  if (exists.rows.length) return bad(res, 'An account with this email already exists.');

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,'student') RETURNING id,name,email,role`,
    [name, email, hash]);
  res.json({ token: signToken(rows[0]), user: publicUser(rows[0]) });
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) return bad(res, 'Incorrect email or password.');
  res.json({ token: signToken(u), user: publicUser(u) });
}));

/* everything below requires login */
app.use('/api', auth);

/* ---------- courses ---------- */
app.get('/api/courses', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id,code,title,year,semester FROM courses ORDER BY year,semester,code');
  res.json(rows);
}));

/* ---------- resources ---------- */
app.get('/api/resources', wrap(async (req, res) => {
  const courseId = parseInt(req.query.course_id, 10);
  if (!courseId) return bad(res, 'course_id is required.');
  const { rows } = await pool.query(
    `SELECT r.id, r.course_id, r.title, r.link, r.type, u.name AS submitted_by_name,
       (SELECT COUNT(*)::int FROM comments c WHERE c.resource_id=r.id) AS comment_count,
       (SELECT ROUND(AVG(rating),1) FROM ratings WHERE resource_id=r.id) AS avg_rating,
       (SELECT COUNT(*)::int FROM ratings WHERE resource_id=r.id) AS rating_count,
       (SELECT rating FROM ratings WHERE resource_id=r.id AND user_id=$2) AS my_rating
     FROM resources r LEFT JOIN users u ON u.id=r.submitted_by
     WHERE r.course_id=$1 AND r.status='approved'
     ORDER BY r.created_at DESC`, [courseId, req.user.id]);
  res.json(rows);
}));

app.get('/api/resources/pending/mine', requireRole('teacher', 'chairman'), wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.title, r.link, c.code AS course_code, u.name AS submitted_by_name
     FROM resources r
     JOIN courses c ON c.id=r.course_id
     LEFT JOIN users u ON u.id=r.submitted_by
     WHERE r.status='pending' AND (
       $1 = 'chairman' OR EXISTS (SELECT 1 FROM assignments a WHERE a.course_id=r.course_id AND a.teacher_id=$2))
     ORDER BY r.created_at`, [req.user.role, req.user.id]);
  res.json(rows);
}));

app.post('/api/resources', wrap(async (req, res) => {
  const courseId = parseInt(req.body.course_id, 10);
  const title = String(req.body.title || '').trim();
  const link = cleanLink(req.body.link);
  if (!title || title.length > 200) return bad(res, 'Please enter a title (max 200 characters).');
  if (!link) return bad(res, 'Please enter a valid http(s) link.');
  const course = await pool.query('SELECT 1 FROM courses WHERE id=$1', [courseId]);
  if (!course.rows.length) return bad(res, 'Course not found.', 404);

  const status = (await canManage(req.user, courseId)) ? 'approved' : 'pending';
  const { rows } = await pool.query(
    `INSERT INTO resources (course_id,title,link,type,status,submitted_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [courseId, title, link, detectType(link), status, req.user.id]);
  res.json({ id: rows[0].id, status });
}));

async function loadResourceForManage(req, res) {
  const { rows } = await pool.query('SELECT * FROM resources WHERE id=$1', [parseInt(req.params.id, 10)]);
  if (!rows[0]) { bad(res, 'Resource not found.', 404); return null; }
  if (!(await canManage(req.user, rows[0].course_id))) { bad(res, 'You cannot manage this course.', 403); return null; }
  return rows[0];
}

app.put('/api/resources/:id/approve', requireRole('teacher', 'chairman'), wrap(async (req, res) => {
  const r = await loadResourceForManage(req, res); if (!r) return;
  await pool.query(`UPDATE resources SET status='approved' WHERE id=$1`, [r.id]);
  res.json({ ok: true });
}));

app.put('/api/resources/:id/reject', requireRole('teacher', 'chairman'), wrap(async (req, res) => {
  const r = await loadResourceForManage(req, res); if (!r) return;
  await pool.query(`UPDATE resources SET status='rejected' WHERE id=$1`, [r.id]);
  res.json({ ok: true });
}));

app.put('/api/resources/:id', requireRole('teacher', 'chairman'), wrap(async (req, res) => {
  const r = await loadResourceForManage(req, res); if (!r) return;
  const title = String(req.body.title || '').trim();
  const link = cleanLink(req.body.link);
  if (!title || title.length > 200) return bad(res, 'Please enter a title (max 200 characters).');
  if (!link) return bad(res, 'Please enter a valid http(s) link.');
  await pool.query('UPDATE resources SET title=$1, link=$2, type=$3 WHERE id=$4', [title, link, detectType(link), r.id]);
  res.json({ ok: true });
}));

app.delete('/api/resources/:id', requireRole('teacher', 'chairman'), wrap(async (req, res) => {
  const r = await loadResourceForManage(req, res); if (!r) return;
  await pool.query('DELETE FROM resources WHERE id=$1', [r.id]);
  res.json({ ok: true });
}));

/* ---------- ratings (students) ---------- */
app.post('/api/ratings', requireRole('student'), wrap(async (req, res) => {
  const resourceId = parseInt(req.body.resource_id, 10);
  const rating = parseInt(req.body.rating, 10);
  if (!(rating >= 1 && rating <= 5)) return bad(res, 'Rating must be between 1 and 5.');
  const r = await pool.query(`SELECT 1 FROM resources WHERE id=$1 AND status='approved'`, [resourceId]);
  if (!r.rows.length) return bad(res, 'Resource not found.', 404);
  await pool.query(
    `INSERT INTO ratings (resource_id,user_id,rating) VALUES ($1,$2,$3)
     ON CONFLICT (resource_id,user_id) DO UPDATE SET rating=EXCLUDED.rating`,
    [resourceId, req.user.id, rating]);
  res.json({ ok: true });
}));

/* ---------- comments ---------- */
app.get('/api/comments', wrap(async (req, res) => {
  const resourceId = parseInt(req.query.resource_id, 10);
  if (!resourceId) return bad(res, 'resource_id is required.');
  const { rows } = await pool.query(
    `SELECT c.id, c.parent_id, c.user_id, c.content, c.created_at, u.name AS user_name, u.role AS user_role
     FROM comments c JOIN users u ON u.id=c.user_id
     WHERE c.resource_id=$1 ORDER BY c.created_at`, [resourceId]);
  res.json(rows);
}));

app.post('/api/comments', wrap(async (req, res) => {
  const resourceId = parseInt(req.body.resource_id, 10);
  const parentId = req.body.parent_id ? parseInt(req.body.parent_id, 10) : null;
  const content = String(req.body.content || '').trim();
  if (!content || content.length > 2000) return bad(res, 'Comment must be 1–2000 characters.');

  const r = await pool.query(`SELECT 1 FROM resources WHERE id=$1 AND status='approved'`, [resourceId]);
  if (!r.rows.length) return bad(res, 'Resource not found.', 404);
  if (parentId) {
    const p = await pool.query('SELECT 1 FROM comments WHERE id=$1 AND resource_id=$2', [parentId, resourceId]);
    if (!p.rows.length) return bad(res, 'Parent comment not found.', 404);
  }
  const { rows } = await pool.query(
    'INSERT INTO comments (resource_id,user_id,parent_id,content) VALUES ($1,$2,$3,$4) RETURNING id',
    [resourceId, req.user.id, parentId, content]);
  res.json({ id: rows[0].id });
}));

app.delete('/api/comments/:id', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT user_id FROM comments WHERE id=$1', [parseInt(req.params.id, 10)]);
  if (!rows[0]) return bad(res, 'Comment not found.', 404);
  if (req.user.role !== 'chairman' && rows[0].user_id !== req.user.id) return bad(res, 'Not allowed.', 403);
  await pool.query('DELETE FROM comments WHERE id=$1', [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

/* ---------- teachers (chairman) ---------- */
app.get('/api/teachers', requireRole('chairman'), wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email,
       COALESCE(json_agg(json_build_object('id',c.id,'code',c.code)) FILTER (WHERE c.id IS NOT NULL), '[]') AS courses
     FROM users u
     LEFT JOIN assignments a ON a.teacher_id=u.id
     LEFT JOIN courses c ON c.id=a.course_id
     WHERE u.role='teacher' GROUP BY u.id ORDER BY u.name`);
  res.json(rows);
}));

app.post('/api/teachers', requireRole('chairman'), wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name) return bad(res, 'Please enter a name.');
  if (!EMAIL_RE.test(email)) return bad(res, 'Please enter a valid email.');
  if (password.length < 6) return bad(res, 'Password must be at least 6 characters.');
  const exists = await pool.query('SELECT 1 FROM users WHERE email=$1', [email]);
  if (exists.rows.length) return bad(res, 'An account with this email already exists.');
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,'teacher') RETURNING id`, [name, email, hash]);
  res.json({ id: rows[0].id });
}));

app.delete('/api/teachers/:id', requireRole('chairman'), wrap(async (req, res) => {
  await pool.query(`DELETE FROM users WHERE id=$1 AND role='teacher'`, [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

/* ---------- assignments ---------- */
app.get('/api/assignments/mine', requireRole('teacher', 'chairman'), wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT course_id FROM assignments WHERE teacher_id=$1', [req.user.id]);
  res.json(rows);
}));

app.get('/api/assignments', requireRole('chairman'), wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, c.code, c.title, u.name AS teacher_name
     FROM assignments a JOIN courses c ON c.id=a.course_id JOIN users u ON u.id=a.teacher_id
     ORDER BY c.year, c.semester, c.code`);
  res.json(rows);
}));

app.post('/api/assignments', requireRole('chairman'), wrap(async (req, res) => {
  const courseId = parseInt(req.body.course_id, 10);
  const teacherId = parseInt(req.body.teacher_id, 10);
  const t = await pool.query(`SELECT 1 FROM users WHERE id=$1 AND role='teacher'`, [teacherId]);
  const c = await pool.query('SELECT 1 FROM courses WHERE id=$1', [courseId]);
  if (!t.rows.length || !c.rows.length) return bad(res, 'Invalid course or teacher.');
  await pool.query(
    'INSERT INTO assignments (course_id,teacher_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [courseId, teacherId]);
  res.json({ ok: true });
}));

app.delete('/api/assignments/:id', requireRole('chairman'), wrap(async (req, res) => {
  await pool.query('DELETE FROM assignments WHERE id=$1', [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

/* ---------- static frontend + fallbacks ---------- */
app.use('/api', (req, res) => bad(res, 'Not found.', 404));
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

const PORT = process.env.PORT || 4000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Study Vault running on port ${PORT}`)))
  .catch(err => { console.error('Startup failed:', err); process.exit(1); });
