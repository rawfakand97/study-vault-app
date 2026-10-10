# Study Vault – Backend + Render deployment

Node/Express + PostgreSQL. The same server also serves the frontend in `public/`.

## Project layout
```
server.js      API routes + static hosting
db.js          DB connection, auto-migrate, course seed, first chairman
schema.sql     tables
courses.json   YOUR SYLLABUS  <-- edit this
render.yaml    Render blueprint (web service + Postgres)
public/        index.html, style.css, script.js
```

## 1. Fill in your courses
Open `courses.json` and list every course (the two entries are only examples):
```json
{ "code": "ICT 1103", "title": "C Programming", "year": 1, "semester": 1 }
```
Re-deploying with new/changed courses updates the DB automatically (matched by `code`).

## 2. Push to GitHub
Copy these files into your `Study_Vault` repo (replace the old root `index.html/style.css/script.js` – they now live in `public/`), then:
```
git add . && git commit -m "Add backend" && git push
```

## 3. Deploy on Render
1. render.com → **New → Blueprint** → connect the `Study_Vault` repo. Render reads `render.yaml` and creates the web service + Postgres database.
2. When asked, fill in:
   - `CHAIRMAN_NAME`, `CHAIRMAN_EMAIL`, `CHAIRMAN_PASSWORD` (your first admin login)
3. Click **Apply**. First build takes a few minutes.
4. Open `https://study-vault-xxxx.onrender.com` and log in as the chairman.
   Then use **Manage Teachers** → **Course Assignments**.

Tables are created automatically on startup; no shell needed.

## Run locally (optional)
```
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/studyvault
export JWT_SECRET=anything
export CHAIRMAN_EMAIL=you@example.com CHAIRMAN_PASSWORD=secret123
npm start      # http://localhost:4000
```

## Notes
- Free web services on Render sleep after inactivity; the first request after a sleep takes ~30–60 s.
- Free Render Postgres has time limits (it has historically expired after ~30 days). Check Render's current free-tier terms, and upgrade the DB or export data before it expires.
- GitHub Pages can't run a backend, so the old github.io link will no longer work. Use the Render URL instead.
