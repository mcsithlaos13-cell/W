CREATE TABLE IF NOT EXISTS genres (
  name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO genres (name) VALUES
  ('ฟังสบาย'), ('อินดี้ป๊อป'), ('อะคูสติก'), ('รีมิกซ์'),
  ('เอฟเฟ็กต์เสียง'), ('เพลง Set'), ('อื่น ๆ');

INSERT OR IGNORE INTO genres (name)
SELECT DISTINCT genre FROM tracks WHERE trim(genre) <> '';
