ALTER TABLE members ADD COLUMN instagram_url TEXT NOT NULL DEFAULT '' CHECK (length(instagram_url) <= 500);
ALTER TABLE members ADD COLUMN whatsapp TEXT NOT NULL DEFAULT '' CHECK (length(whatsapp) <= 500);
ALTER TABLE members ADD COLUMN tiktok_url TEXT NOT NULL DEFAULT '' CHECK (length(tiktok_url) <= 500);
