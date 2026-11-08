ALTER TABLE tracks ADD COLUMN cover_checked INTEGER NOT NULL DEFAULT 0;
UPDATE tracks SET cover_checked = 1 WHERE cover_content_type <> '';
