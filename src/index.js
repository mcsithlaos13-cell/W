const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_DAILY_UPLOADS_PER_IP = 5;
const MAX_DAILY_UPLOADS_GLOBAL = 20;
const MAX_LIBRARY_BYTES = 2 * 1024 * 1024 * 1024;
const ALLOWED_GENRES = new Set(["ฟังสบาย", "อินดี้ป๊อป", "อะคูสติก", "รีมิกซ์", "เอฟเฟ็กต์เสียง", "เพลง Set", "อื่น ๆ"]);

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
}

function safeFilename(name) {
  return name.replace(/[\r\n"\\/]/g, "_").slice(0, 180) || "audio";
}

async function isAdmin(request, env) {
  const expected = env.ADMIN_TOKEN;
  const actual = request.headers.get("authorization") || "";
  const supplied = actual.startsWith("Bearer ") ? actual.slice(7) : "";
  if (!expected || !supplied) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function getUploadIpHash(request, env) {
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip || !env.ADMIN_TOKEN) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.ADMIN_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isFacebookProfile(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)facebook\.com$|(^|\.)fb\.me$/.test(url.hostname);
  } catch { return false; }
}

function isSocialProfile(value, domains) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

function isWhatsAppContact(value) {
  if (/^\+?[0-9][0-9\s()-]{6,24}$/.test(value)) return true;
  return isSocialProfile(value, ["wa.me", "whatsapp.com"]);
}

async function api(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/health" && request.method === "GET") {
    try {
      await env.DB.prepare("SELECT 1").first();
      return json({ ok: true, service: "khlun-music" });
    } catch {
      return json({ ok: false, error: "database_unavailable" }, 503);
    }
  }

  if (url.pathname === "/api/tracks" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, title, artist, album, genre, size_bytes, created_at FROM tracks ORDER BY created_at DESC LIMIT 250",
    ).all();
    return json({ tracks: results });
  }

  if (url.pathname === "/api/members" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, display_name, artist_name, facebook_url, created_at FROM members ORDER BY created_at DESC LIMIT 500",
    ).all();
    return json({ members: results });
  }

  if (url.pathname === "/api/members" && request.method === "POST") {
    if (!(await isAdmin(request, env))) return json({ error: "รหัสผู้ดูแลไม่ถูกต้อง" }, 401);
    let body;
    try { body = await request.json(); } catch { return json({ error: "ข้อมูลสมาชิกไม่ถูกต้อง" }, 400); }
    const displayName = String(body.display_name || "").trim();
    const artistName = String(body.artist_name || "").trim();
    const facebookUrl = String(body.facebook_url || "").trim();
    if (!displayName || displayName.length > 80 || artistName.length > 120 || facebookUrl.length > 500) {
      return json({ error: "กรุณาตรวจชื่อสมาชิก ชื่อศิลปิน และลิงก์ Facebook" }, 400);
    }
    if (facebookUrl && !isFacebookProfile(facebookUrl)) return json({ error: "ลิงก์ Facebook ต้องขึ้นต้นด้วย https:// และเป็นลิงก์ Facebook" }, 400);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO members (id, display_name, artist_name, facebook_url) VALUES (?, ?, ?, ?)",
    ).bind(id, displayName, artistName, facebookUrl).run();
    return json({ ok: true, id }, 201);
  }

  const memberMatch = url.pathname.match(/^\/api\/members\/([0-9a-f-]{36})$/i);
  if (memberMatch && request.method === "DELETE") {
    if (!(await isAdmin(request, env))) return json({ error: "รหัสผู้ดูแลไม่ถูกต้อง" }, 401);
    const result = await env.DB.prepare("DELETE FROM members WHERE id = ?").bind(memberMatch[1]).run();
    if (result.meta.changes !== 1) return json({ error: "ไม่พบรายชื่อนี้" }, 404);
    return new Response(null, { status: 204 });
  }

  if (url.pathname === "/api/creators" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, display_name, services, facebook_url, instagram_url, whatsapp, tiktok_url, created_at FROM creators ORDER BY created_at DESC LIMIT 500",
    ).all();
    return json({ creators: results });
  }

  if (url.pathname === "/api/creators" && request.method === "POST") {
    if (!(await isAdmin(request, env))) return json({ error: "รหัสผู้ดูแลไม่ถูกต้อง" }, 401);
    let body;
    try { body = await request.json(); } catch { return json({ error: "ข้อมูลครีเอเตอร์ไม่ถูกต้อง" }, 400); }
    const displayName = String(body.display_name || "").trim();
    const services = String(body.services || "").trim();
    const facebookUrl = String(body.facebook_url || "").trim();
    const instagramUrl = String(body.instagram_url || "").trim();
    const whatsapp = String(body.whatsapp || "").trim();
    const tiktokUrl = String(body.tiktok_url || "").trim();
    if (!displayName || displayName.length > 80 || !services || services.length > 300 || facebookUrl.length > 500 || instagramUrl.length > 500 || whatsapp.length > 500 || tiktokUrl.length > 500) {
      return json({ error: "กรุณาตรวจชื่อครีเอเตอร์ งานที่รับ และข้อมูลช่องทางติดต่อ" }, 400);
    }
    if (facebookUrl && !isFacebookProfile(facebookUrl)) return json({ error: "ลิงก์ Facebook ต้องขึ้นต้นด้วย https:// และเป็นลิงก์ Facebook" }, 400);
    if (instagramUrl && !isSocialProfile(instagramUrl, ["instagram.com"])) return json({ error: "กรุณาใส่ลิงก์ Instagram ที่ถูกต้อง" }, 400);
    if (whatsapp && !isWhatsAppContact(whatsapp)) return json({ error: "WhatsApp ให้ใส่เบอร์โทรหรือ URL wa.me / whatsapp.com" }, 400);
    if (tiktokUrl && !isSocialProfile(tiktokUrl, ["tiktok.com"])) return json({ error: "กรุณาใส่ลิงก์ TikTok ที่ถูกต้อง" }, 400);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO creators (id, display_name, services, facebook_url, instagram_url, whatsapp, tiktok_url) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, displayName, services, facebookUrl, instagramUrl, whatsapp, tiktokUrl).run();
    return json({ ok: true, id }, 201);
  }

  const creatorMatch = url.pathname.match(/^\/api\/creators\/([0-9a-f-]{36})$/i);
  if (creatorMatch && request.method === "DELETE") {
    if (!(await isAdmin(request, env))) return json({ error: "รหัสผู้ดูแลไม่ถูกต้อง" }, 401);
    const result = await env.DB.prepare("DELETE FROM creators WHERE id = ?").bind(creatorMatch[1]).run();
    if (result.meta.changes !== 1) return json({ error: "ไม่พบรายชื่อนี้" }, 404);
    return new Response(null, { status: 204 });
  }

  if (url.pathname === "/api/admin/verify" && request.method === "GET") {
    if (!(await isAdmin(request, env))) return json({ error: "รหัสผู้ดูแลไม่ถูกต้อง" }, 401);
    return json({ ok: true });
  }

  const audioMatch = url.pathname.match(/^\/api\/audio\/([0-9a-f-]{36})$/i);
  if (audioMatch && request.method === "GET") {
    const track = await env.DB.prepare("SELECT object_key, original_name, content_type FROM tracks WHERE id = ?")
      .bind(audioMatch[1]).first();
    if (!track) return json({ error: "ไม่พบเพลงนี้" }, 404);
    const object = await env.AUDIO.get(track.object_key);
    if (!object) return json({ error: "ไม่พบไฟล์เสียง" }, 404);
    const headers = new Headers({
      "content-type": track.content_type,
      "cache-control": "public, max-age=3600",
      "accept-ranges": "bytes",
      "x-content-type-options": "nosniff",
    });
    if (url.searchParams.get("download") === "1") {
      headers.set("content-disposition", `attachment; filename="${safeFilename(track.original_name)}"; filename*=UTF-8''${encodeURIComponent(track.original_name)}`);
    }
    return new Response(object.body, { headers });
  }

  if (url.pathname === "/api/tracks" && request.method === "POST") {
    const ipHash = await getUploadIpHash(request, env);
    if (!ipHash) return json({ error: "ไม่สามารถตรวจสอบการอัปโหลดนี้ได้" }, 403);
    let form;
    try { form = await request.formData(); } catch { return json({ error: "ข้อมูลอัปโหลดไม่ถูกต้อง" }, 400); }
    const title = String(form.get("title") || "").trim();
    const artist = String(form.get("artist") || "").trim();
    const album = String(form.get("album") || "").trim();
    const requestedGenre = String(form.get("genre") || "อื่น ๆ");
    const genre = ALLOWED_GENRES.has(requestedGenre) ? requestedGenre : "อื่น ๆ";
    const file = form.get("audio");
    if (!title || title.length > 120 || !artist || artist.length > 120 || album.length > 120) {
      return json({ error: "กรุณากรอกชื่อเพลงและศิลปิน (ไม่เกิน 120 ตัวอักษร)" }, 400);
    }
    if (!(file instanceof File) || file.size < 1 || file.size > MAX_UPLOAD_BYTES || !file.type.startsWith("audio/")) {
      return json({ error: "เลือกไฟล์เสียงขนาดไม่เกิน 20 MB" }, 400);
    }
    await env.DB.prepare("DELETE FROM upload_attempts WHERE uploaded_at < datetime('now', '-2 days')").run();
    const reservation = await env.DB.prepare(
      "INSERT INTO upload_attempts (ip_hash) SELECT ? WHERE (SELECT COUNT(*) FROM upload_attempts WHERE ip_hash = ? AND uploaded_at >= datetime('now', '-1 day')) < ? AND (SELECT COUNT(*) FROM upload_attempts WHERE uploaded_at >= datetime('now', '-1 day')) < ? AND (SELECT COALESCE(SUM(size_bytes), 0) FROM tracks) + ? <= ?",
    ).bind(ipHash, ipHash, MAX_DAILY_UPLOADS_PER_IP, MAX_DAILY_UPLOADS_GLOBAL, file.size, MAX_LIBRARY_BYTES).run();
    if (reservation.meta.changes !== 1) {
      const usage = await env.DB.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS total_bytes FROM tracks").first();
      if (usage?.total_bytes + file.size > MAX_LIBRARY_BYTES) {
        return json({ error: "พื้นที่คลังเพลงเต็มชั่วคราว กรุณาติดต่อผู้ดูแล" }, 507);
      }
      return json({ error: "อัปโหลดถึงจำนวนที่กำหนดแล้ว กรุณาลองใหม่ภายหลัง" }, 429, { "retry-after": "86400" });
    }
    const id = crypto.randomUUID();
    const objectKey = `tracks/${id}`;
    const originalName = safeFilename(file.name);
    try {
      await env.AUDIO.put(objectKey, file.stream(), {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
        customMetadata: { trackId: id },
      });
    } catch (error) {
      await env.DB.prepare("DELETE FROM upload_attempts WHERE id = ?").bind(reservation.meta.last_row_id).run();
      console.error("audio_upload_failed", { id, message: String(error) });
      return json({ error: "อัปโหลดไฟล์เสียงไม่สำเร็จ กรุณาลองอีกครั้ง" }, 502);
    }
    try {
      await env.DB.prepare(
        "INSERT INTO tracks (id, title, artist, album, genre, object_key, original_name, content_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(id, title, artist, album, genre, objectKey, originalName, file.type || "application/octet-stream", file.size).run();
    } catch (error) {
      await env.AUDIO.delete(objectKey);
      await env.DB.prepare("DELETE FROM upload_attempts WHERE id = ?").bind(reservation.meta.last_row_id).run();
      console.error("track_insert_failed", { id, message: String(error) });
      return json({ error: "บันทึกข้อมูลเพลงไม่สำเร็จ" }, 500);
    }
    return json({ id, title, artist }, 201);
  }

  const trackMatch = url.pathname.match(/^\/api\/tracks\/([0-9a-f-]{36})$/i);
  if (trackMatch && request.method === "PATCH") {
    if (!(await isAdmin(request, env))) return json({ error: "รหัสผู้ดูแลไม่ถูกต้อง" }, 401);
    let body;
    try { body = await request.json(); } catch { return json({ error: "ข้อมูลเพลงไม่ถูกต้อง" }, 400); }
    const title = String(body.title || "").trim();
    const artist = String(body.artist || "").trim();
    const album = String(body.album || "").trim();
    const genre = String(body.genre || "");
    if (!title || title.length > 120 || !artist || artist.length > 120 || album.length > 120 || !ALLOWED_GENRES.has(genre)) {
      return json({ error: "กรุณาตรวจชื่อเพลง ศิลปิน อัลบั้ม และแนวเพลง" }, 400);
    }
    const result = await env.DB.prepare(
      "UPDATE tracks SET title = ?, artist = ?, album = ?, genre = ? WHERE id = ?",
    ).bind(title, artist, album, genre, trackMatch[1]).run();
    if (result.meta.changes !== 1) return json({ error: "ไม่พบเพลงนี้" }, 404);
    return json({ ok: true, id: trackMatch[1] });
  }

  if (trackMatch && request.method === "DELETE") {
    if (!(await isAdmin(request, env))) return json({ error: "รหัสผู้ดูแลไม่ถูกต้อง" }, 401);
    const track = await env.DB.prepare("SELECT object_key FROM tracks WHERE id = ?").bind(trackMatch[1]).first();
    if (!track) return json({ error: "ไม่พบเพลงนี้" }, 404);
    await env.DB.prepare("DELETE FROM tracks WHERE id = ?").bind(trackMatch[1]).run();
    await env.AUDIO.delete(track.object_key);
    return new Response(null, { status: 204 });
  }

  return json({ error: "ไม่พบเส้นทางนี้" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env); }
      catch (error) {
        console.error("api_request_failed", { path: url.pathname, message: String(error) });
        return json({ error: "เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

