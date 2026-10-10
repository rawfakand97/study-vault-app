const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false
});

function detectType(link) {
  const host = new URL(link).hostname.replace(/^www\./, '');
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) return 'yt';
  if (/^(drive|docs)\.google\.com$/.test(host)) return 'drive';
  return 'link';
}

// Runs on every boot. Everything here is idempotent, so you never need a shell.
async function initDb() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  // Sync courses (add new, update titles/year/semester of existing ones by code)
  const courses = JSON.parse(fs.readFileSync(path.join(__dirname, 'courses.json'), 'utf8'));
  for (const c of courses) {
    await pool.query(
      `INSERT INTO courses (code, title, year, semester) VALUES ($1,$2,$3,$4)
       ON CONFLICT (code) DO UPDATE SET title=EXCLUDED.title, year=EXCLUDED.year, semester=EXCLUDED.semester`,
      [c.code, c.title, c.year, c.semester]
    );
  }

  // Remove leftover courses no longer in courses.json (only if nothing is attached to them)
  await pool.query(
    `DELETE FROM courses WHERE code <> ALL($1::text[])
       AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.course_id = courses.id)
       AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.course_id = courses.id)`,
    [courses.map(c => c.code)]
  );

  // One-time import of starter resources (runs once, so deleted ones never come back)
  const seeded = await pool.query(`SELECT 1 FROM app_meta WHERE key='resources_seeded'`);
  if (seeded.rows.length === 0) {
    const file = path.join(__dirname, 'seed-resources.json');
    const items = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    for (const r of items) {
      await pool.query(
        `INSERT INTO resources (course_id, title, link, type, status)
         SELECT c.id, $2, $3, $4, 'approved' FROM courses c
         WHERE c.code = $1
           AND NOT EXISTS (SELECT 1 FROM resources x WHERE x.course_id = c.id AND x.link = $3)`,
        [r.course_code, r.title, r.link, detectType(r.link)]
      );
    }
    await pool.query(`INSERT INTO app_meta (key, value) VALUES ('resources_seeded','1')`);
    console.log(`Seeded ${items.length} starter resources`);
  }

  // Create the first Chairman from env vars if none exists
  const { rows } = await pool.query(`SELECT 1 FROM users WHERE role='chairman' LIMIT 1`);
  if (rows.length === 0) {
    const email = (process.env.CHAIRMAN_EMAIL || '').trim().toLowerCase();
    const password = process.env.CHAIRMAN_PASSWORD || '';
    if (email && password.length >= 6) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'chairman')
         ON CONFLICT (email) DO UPDATE SET role='chairman'`,
        [process.env.CHAIRMAN_NAME || 'Chairman', email, hash]
      );
      console.log('Chairman account created for', email);
    } else {
      console.warn('No chairman exists. Set CHAIRMAN_EMAIL and CHAIRMAN_PASSWORD (6+ chars).');
    }
  }
}

module.exports = { pool, initDb };
