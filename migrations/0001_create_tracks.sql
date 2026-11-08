CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  artist TEXT NOT NULL CHECK (length(artist) BETWEEN 1 AND 120),
  album TEXT NOT NULL DEFAULT '',
  genre TEXT NOT NULL DEFAULT 'อื่น ๆ',
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_tracks_created_at ON tracks(created_at DESC);

