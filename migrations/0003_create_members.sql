CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  artist_name TEXT NOT NULL DEFAULT '' CHECK (length(artist_name) <= 120),
  facebook_url TEXT NOT NULL DEFAULT '' CHECK (length(facebook_url) <= 500),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_members_created_at ON members(created_at DESC);

CREATE TABLE IF NOT EXISTS creators (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  services TEXT NOT NULL CHECK (length(services) BETWEEN 1 AND 300),
  facebook_url TEXT NOT NULL DEFAULT '' CHECK (length(facebook_url) <= 500),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_creators_created_at ON creators(created_at DESC);

