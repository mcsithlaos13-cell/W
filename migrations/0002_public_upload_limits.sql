CREATE TABLE IF NOT EXISTS upload_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_upload_attempts_ip_time ON upload_attempts(ip_hash, uploaded_at);
CREATE INDEX IF NOT EXISTS idx_upload_attempts_time ON upload_attempts(uploaded_at);

