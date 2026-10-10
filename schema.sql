CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('student','teacher','chairman')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS courses (
  id       SERIAL PRIMARY KEY,
  code     TEXT NOT NULL UNIQUE,
  title    TEXT NOT NULL,
  year     INT  NOT NULL,
  semester INT  NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments (
  id         SERIAL PRIMARY KEY,
  course_id  INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  teacher_id INT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  UNIQUE (course_id, teacher_id)
);

CREATE TABLE IF NOT EXISTS resources (
  id           SERIAL PRIMARY KEY,
  course_id    INT  NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  link         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'link',
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  submitted_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_resources_course ON resources(course_id, status);

CREATE TABLE IF NOT EXISTS ratings (
  id          SERIAL PRIMARY KEY,
  resource_id INT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  user_id     INT NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  rating      INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  UNIQUE (resource_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id          SERIAL PRIMARY KEY,
  resource_id INT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  user_id     INT NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  parent_id   INT REFERENCES comments(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comments_resource ON comments(resource_id);
