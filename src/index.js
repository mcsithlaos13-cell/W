const MAX_AUDIO_UPLOAD_BYTES = 85 * 1024 * 1024;
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const ALLOWED_COVER_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_GENRES = new Set(["ฟังสบาย", "อินดี้ป๊อป", "อะคูสติก", "รีมิกซ์", "เอฟเฟ็กต์เสียง", "เพลง Set", "อื่น ๆ"]);
const ID3_SCAN_BYTES = 8 * 1024 * 1024;

function extractId3Cover(bytes) {
  if (bytes.length < 10 || String.fromCharCode(...bytes.subarray(0, 3)) !== "ID3") return null;
  const version = bytes[3];
  if (version < 2 || version > 4) return null;
  const tagSize = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
  const end = Math.min(10 + tagSize, bytes.length);
  let offset = 10;
  if (bytes[5] & 0x40) {
    if (version === 3) offset += 4 + ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);
    else if (version === 4) offset += (bytes[offset] << 21) | (bytes[offset + 1] << 14) | (bytes[offset + 2] << 7) | bytes[offset + 3];
  }
  const decoder = new TextDecoder("latin1");
  while (offset + 10 <= end) {
    const frameId = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
    const frameSize = version === 4
      ? (bytes[offset + 4] << 21) | (bytes[offset + 5] << 14) | (bytes[offset + 6] << 7) | bytes[offset + 7]
      : (bytes[offset + 4] * 0x1000000) + (bytes[offset + 5] << 16) + (bytes[offset + 6] << 8) + bytes[offset + 7];
    if (!frameSize || offset + 10 + frameSize > end) break;
    const start = offset + 10, frameEnd = start + frameSize;
    if (frameId === "APIC") {
      const encoding = bytes[start];
      let cursor = start + 1, mimeEnd = cursor;
      while (mimeEnd < frameEnd && bytes[mimeEnd] !== 0) mimeEnd++;
      const rawMime = decoder.decode(bytes.subarray(cursor, mimeEnd)).toLowerCase();
      cursor = mimeEnd + 1 + 1;
      const wide = encoding === 1 || encoding === 2;
      while (cursor < frameEnd - 1) {
        if (wide ? bytes[cursor] === 0 && bytes[cursor + 1] === 0 : bytes[cursor] === 0) {
          cursor += wide ? 2 : 1;
          break;
        }
        cursor += wide ? 2 : 1;
      }
      const image = bytes.slice(cursor, frameEnd);
      const type = rawMime.includes("png") ? "image/png" : rawMime.includes("webp") ? "image/webp" : rawMime.includes("jpeg") || rawMime.includes("jpg") ? "image/jpeg" : "";
      if (type && image.length > 0 && image.length <= MAX_COVER_BYTES) return { type, image };
    }
    offset = frameEnd;
  }
  return null;
}

async function extractTrackCover(env, objectKey) {
  const object = await env.AUDIO.get(objectKey, { range: { offset: 0, length: ID3_SCAN_BYTES } });
  if (!object) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  return extractId3Cover(bytes);
}

async function backfillEmbeddedCovers(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, object_key FROM tracks WHERE cover_checked = 0 AND cover_content_type = '' AND content_type IN ('audio/mpeg', 'audio/mp3') ORDER BY created_at DESC LIMIT 4",
  ).all();
  for (const track of results) {
    try {
      const cover = await extractTrackCover(env, track.object_key);
      if (cover) {
        const key = `covers/${track.id}`;
        await env.AUDIO.put(key, cover.image, { httpMetadata: { contentType: cover.type }, customMetadata: { trackId: track.id, purpose: "cover" } });
        await env.DB.prepare("UPDATE tracks SET cover_key = ?, cover_content_type = ?, cover_checked = 1 WHERE id = ?")
          .bind(key, cover.type, track.id).run();
      } else {
        await env.DB.prepare("UPDATE tracks SET cover_checked = 1 WHERE id = ?").bind(track.id).run();
      }
    } catch (error) {
      console.error("embedded_cover_backfill_failed", { id: track.id, message: String(error) });
    }
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
}

function safeFilename(name) {
  return name.replace(/[\r\n"\\/]/g, "_").replace(/[^\x20-\x7E]/g, "_").slice(0, 180) || "audio";
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
    await backfillEmbeddedCovers(env);
    const { results } = await env.DB.prepare(
      "SELECT id, title, artist, album, genre, size_bytes, created_at, cover_content_type, download_count FROM tracks ORDER BY created_at DESC",
    ).all();
    return json({ tracks: results });
  }

  if (url.pathname === "/api/genres" && request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT name FROM genres ORDER BY name COLLATE NOCASE").all();
    return json({ genres: results.map((row) => row.name) });
  }

  if (url.pathname === "/api/genres" && request.method === "POST") {
    if (!(await isAdmin(request, env))) return json({ error: "รหัสผู้ดูแลไม่ถูกต้อง" }, 401);
    let body;
    try { body = await request.json(); } catch { return json({ error: "ข้อมูลหมวดหมู่ไม่ถูกต้อง" }, 400); }
    const name = String(body.name || "").trim();
    if (!name || name.length > 40 || /[<>\r\n]/.test(name)) return json({ error: "ชื่อหมวดหมู่ต้องมี 1–40 ตัวอักษร" }, 400);
    try {
      await env.DB.prepare("INSERT INTO genres (name) VALUES (?)").bind(name).run();
    } catch {
      return json({ error: "มีหมวดหมู่นี้อยู่แล้ว" }, 409);
    }
    return json({ ok: true, name }, 201);
  }

  if (url.pathname === "/api/members" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, display_name, artist_name, facebook_url, instagram_url, whatsapp, tiktok_url, created_at FROM members ORDER BY created_at DESC LIMIT 500",
    ).all();
    return json({ members: results });
  }

  const profileImageMatch = url.pathname.match(/^\/api\/profile-images\/(members|creators)\/([0-9a-f-]{36})$/i);
  if (profileImageMatch && request.method === "GET") {
    const [, collection, id] = profileImageMatch;
    const table = collection === "members" ? "members" : "creators";
    const exists = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first();
    if (!exists) return json({ error: "ไม่พบรายชื่อนี้" }, 404);
    const object = await env.AUDIO.get(`profiles/${collection}/${id}`);
    if (!object) return json({ error: "ยังไม่มีรูปประจำตัว" }, 404);
    return new Response(object.body, { headers: {
      "content-type": object.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    } });
  }
  if (profileImageMatch && request.method === "PUT") {
    if (!(await isAdmin(request, env))) return json({ error: "รหัสผู้ดูแลไม่ถูกต้อง" }, 401);
    const contentType = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(contentType)) {
      return json({ error: "รูปต้องเป็น JPG, PNG หรือ WebP" }, 400);
    }
    if (declaredLength > MAX_COVER_BYTES) return json({ error: "รูปต้องมีขนาดไม่เกิน 5 MB" }, 413);
    const [, collection, id] = profileImageMatch;
    const table = collection === "members" ? "members" : "creators";
    const exists = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first();
    if (!exists) return json({ error: "ไม่พบรายชื่อนี้" }, 404);
    const image = await request.arrayBuffer();
    if (!image.byteLength || image.byteLength > MAX_COVER_BYTES) return json({ error: "รูปต้องมีขนาดไม่เกิน 5 MB" }, 413);
    await env.AUDIO.put(`profiles/${collection}/${id}`, image, {
      httpMetadata: { contentType },
      customMetadata: { profileType: collection, profileId: id },
    });
    return json({ ok: true, image_url: `/api/profile-images/${collection}/${id}` });
  }

  if (url.pathname === "/api/members" && request.method === "POST") {
    if (!(await isAdmin(request, env))) return json({ error: "รหัสผู้ดูแลไม่ถูกต้อง" }, 401);
    let body;
    try { body = await request.json(); } catch { return json({ error: "ข้อมูลสมาชิกไม่ถูกต้อง" }, 400); }
    const displayName = String(body.display_name || "").trim();
    const artistName = String(body.artist_name || "").trim();
    const facebookUrl = String(body.facebook_url || "").trim();
    const instagramInput = String(body.instagram_url || "").trim();
    const tiktokInput = String(body.tiktok_url || "").trim();
    const whatsapp = String(body.whatsapp || "").trim();
    const instagramUrl = instagramInput && !/^[a-z][a-z0-9+.-]*:\/\//i.test(instagramInput) ? `https://instagram.com/${instagramInput.replace(/^@/, "")}` : instagramInput;
    const tiktokUrl = tiktokInput && !/^[a-z][a-z0-9+.-]*:\/\//i.test(tiktokInput) ? `https://tiktok.com/@${tiktokInput.replace(/^@/, "")}` : tiktokInput;
    if (!displayName || displayName.length > 80 || artistName.length > 120 || facebookUrl.length > 500 || instagramUrl.length > 500 || whatsapp.length > 500 || tiktokUrl.length > 500) {
      return json({ error: "กรุณาตรวจชื่อสมาชิก ชื่อศิลปิน และลิงก์โซเชียล" }, 400);
    }
    if (facebookUrl && !isFacebookProfile(facebookUrl)) return json({ error: "ลิงก์ Facebook ต้องขึ้นต้นด้วย https:// และเป็นลิงก์ Facebook" }, 400);
    if (instagramUrl && !isSocialProfile(instagramUrl, ["instagram.com"])) return json({ error: "กรุณาใส่ชื่อผู้ใช้หรือลิงก์ Instagram ที่ถูกต้อง" }, 400);
    if (whatsapp && !isWhatsAppContact(whatsapp)) return json({ error: "WhatsApp ให้ใส่เบอร์โทรหรือ URL wa.me / whatsapp.com" }, 400);
    if (tiktokUrl && !isSocialProfile(tiktokUrl, ["tiktok.com"])) return json({ error: "กรุณาใส่ชื่อผู้ใช้หรือลิงก์ TikTok ที่ถูกต้อง" }, 400);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO members (id, display_name, artist_name, facebook_url, instagram_url, whatsapp, tiktok_url) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, displayName, artistName, facebookUrl, instagramUrl, whatsapp, tiktokUrl).run();
    return json({ ok: true, id }, 201);
  }

  const memberMatch = url.pathname.match(/^\/api\/members\/([0-9a-f-]{36})$/i);
  if (memberMatch && request.method === "PATCH") {
    if (!(await isAdmin(request, env))) return json({ error: "รหัสผู้ดูแลไม่ถูกต้อง" }, 401);
    let body;
    try { body = await request.json(); } catch { return json({ error: "ข้อมูลสมาชิกไม่ถูกต้อง" }, 400); }
    const displayName = String(body.display_name || "").trim();
    const artistName = String(body.artist_name || "").trim();
    const facebookUrl = String(body.facebook_url || "").trim();
    const instagramInput = String(body.instagram_url || "").trim();
    const tiktokInput = String(body.tiktok_url || "").trim();
    const whatsapp = String(body.whatsapp || "").trim();
    const instagramUrl = instagramInput && !/^[a-z][a-z0-9+.-]*:\/\//i.test(instagramInput) ? `https://instagram.com/${instagramInput.replace(/^@/, "")}` : instagramInput;
    const tiktokUrl = tiktokInput && !/^[a-z][a-z0-9+.-]*:\/\//i.test(tiktokInput) ? `https://tiktok.com/@${tiktokInput.replace(/^@/, "")}` : tiktokInput;
    if (!displayName || displayName.length > 80 || artistName.length > 120 || facebookUrl.length > 500 || instagramUrl.length > 500 || whatsapp.length > 500 || tiktokUrl.length > 500) {
      return json({ error: "กรุณาตรวจชื่อสมาชิก ชื่อศิลปิน และลิงก์โซเชียล" }, 400);
    }
    if (facebookUrl && !isFacebookProfile(facebookUrl)) return json({ error: "ลิงก์ Facebook ต้องขึ้นต้นด้วย https:// และเป็นลิงก์ Facebook" }, 400);
    if (instagramUrl && !isSocialProfile(instagramUrl, ["instagram.com"])) return json({ error: "กรุณาใส่ชื่อผู้ใช้หรือลิงก์ Instagram ที่ถูกต้อง" }, 400);
    if (whatsapp && !isWhatsAppContact(whatsapp)) return json({ error: "WhatsApp ให้ใส่เบอร์โทรหรือ URL wa.me / whatsapp.com" }, 400);
    if (tiktokUrl && !isSocialProfile(tiktokUrl, ["tiktok.com"])) return json({ error: "กรุณาใส่ชื่อผู้ใช้หรือลิงก์ TikTok ที่ถูกต้อง" }, 400);
    const result = await env.DB.prepare(
      "UPDATE members SET display_name = ?, artist_name = ?, facebook_url = ?, instagram_url = ?, whatsapp = ?, tiktok_url = ? WHERE id = ?",
    ).bind(displayName, artistName, facebookUrl, instagramUrl, whatsapp, tiktokUrl, memberMatch[1]).run();
    if (result.meta.changes !== 1) return json({ error: "ไม่พบรายชื่อนี้" }, 404);
    return json({ ok: true, id: memberMatch[1] });
  }

  if (memberMatch && request.method === "DELETE") {
    if (!(await isAdmin(request, env))) return json({ error: "รหัสผู้ดูแลไม่ถูกต้อง" }, 401);
    const result = await env.DB.prepare("DELETE FROM members WHERE id = ?").bind(memberMatch[1]).run();
    if (result.meta.changes !== 1) return json({ error: "ไม่พบรายชื่อนี้" }, 404);
    await env.AUDIO.delete(`profiles/members/${memberMatch[1]}`);
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
  if (creatorMatch && request.method === "PATCH") {
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
    const result = await env.DB.prepare(
      "UPDATE creators SET display_name = ?, services = ?, facebook_url = ?, instagram_url = ?, whatsapp = ?, tiktok_url = ? WHERE id = ?",
    ).bind(displayName, services, facebookUrl, instagramUrl, whatsapp, tiktokUrl, creatorMatch[1]).run();
    if (result.meta.changes !== 1) return json({ error: "ไม่พบครีเอเตอร์รายนี้" }, 404);
    return json({ ok: true, id: creatorMatch[1] });
  }
  if (creatorMatch && request.method === "DELETE") {
    if (!(await isAdmin(request, env))) return json({ error: "รหัสผู้ดูแลไม่ถูกต้อง" }, 401);
    const result = await env.DB.prepare("DELETE FROM creators WHERE id = ?").bind(creatorMatch[1]).run();
    if (result.meta.changes !== 1) return json({ error: "ไม่พบรายชื่อนี้" }, 404);
    await env.AUDIO.delete(`profiles/creators/${creatorMatch[1]}`);
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
    const isDownload = url.searchParams.get("download") === "1";
    const headers = new Headers({
      "content-type": track.content_type,
      "cache-control": "public, max-age=3600",
      "accept-ranges": "bytes",
      "x-content-type-options": "nosniff",
    });
    if (isDownload) {
      const encodedName = encodeURIComponent(track.original_name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      headers.set("content-disposition", `attachment; filename="${safeFilename(track.original_name)}"; filename*=UTF-8''${encodedName}`);
      await env.DB.prepare("UPDATE tracks SET download_count = download_count + 1 WHERE id = ?").bind(audioMatch[1]).run();
    }
    return new Response(object.body, { headers });
  }

  const coverMatch = url.pathname.match(/^\/api\/covers\/([0-9a-f-]{36})$/i);
  if (coverMatch && request.method === "GET") {
    const track = await env.DB.prepare("SELECT cover_key, cover_content_type FROM tracks WHERE id = ?")
      .bind(coverMatch[1]).first();
    if (!track?.cover_key || !track.cover_content_type) return json({ error: "ไม่พบรูปปกเพลง" }, 404);
    const object = await env.AUDIO.get(track.cover_key);
    if (!object) return json({ error: "ไม่พบรูปปกเพลง" }, 404);
    return new Response(object.body, { headers: {
      "content-type": track.cover_content_type,
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    } });
  }

  if (url.pathname === "/api/tracks" && request.method === "POST") {
    let form;
    try { form = await request.formData(); } catch { return json({ error: "ข้อมูลอัปโหลดไม่ถูกต้อง" }, 400); }
    const title = String(form.get("title") || "").trim();
    const artist = String(form.get("artist") || "").trim();
    const album = String(form.get("album") || "").trim();
    const requestedGenre = String(form.get("genre") || "อื่น ๆ");
    const knownGenre = await env.DB.prepare("SELECT name FROM genres WHERE name = ?").bind(requestedGenre).first();
    const genre = knownGenre?.name || "อื่น ๆ";
    const file = form.get("audio");
    const coverFile = form.get("cover");
    if (!title || title.length > 120 || !artist || artist.length > 120 || album.length > 120) {
      return json({ error: "กรุณากรอกชื่อเพลงและศิลปิน (ไม่เกิน 120 ตัวอักษร)" }, 400);
    }
    if (!(file instanceof File) || file.size < 1 || file.size > MAX_AUDIO_UPLOAD_BYTES || !file.type.startsWith("audio/")) {
      return json({ error: "ไฟล์เสียงต้องมีขนาดไม่เกิน 85 MB ต่อเพลง ซึ่งเป็นขีดจำกัดของ Cloudflare" }, 400);
    }
    const hasCover = coverFile instanceof File && coverFile.size > 0;
    if (hasCover && (coverFile.size > MAX_COVER_BYTES || !ALLOWED_COVER_TYPES.has(coverFile.type))) {
      return json({ error: "รูปปกต้องเป็น JPG, PNG หรือ WebP และมีขนาดไม่เกิน 5 MB" }, 400);
    }
    const id = crypto.randomUUID();
    const objectKey = `tracks/${id}`;
    let coverKey = hasCover ? `covers/${id}` : "";
    let coverType = hasCover ? coverFile.type : "";
    const originalName = safeFilename(file.name);
    try {
      await env.AUDIO.put(objectKey, file.stream(), {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
        customMetadata: { trackId: id },
      });
    } catch (error) {
      console.error("audio_upload_failed", { id, message: String(error) });
      return json({ error: "อัปโหลดไฟล์เสียงไม่สำเร็จ กรุณาลองอีกครั้ง" }, 502);
    }
    if (hasCover) {
      try {
        await env.AUDIO.put(coverKey, coverFile.stream(), {
          httpMetadata: { contentType: coverFile.type },
          customMetadata: { trackId: id, purpose: "cover" },
        });
      } catch (error) {
        await env.AUDIO.delete(objectKey);
        console.error("cover_upload_failed", { id, message: String(error) });
        return json({ error: "อัปโหลดรูปปกไม่สำเร็จ กรุณาลองอีกครั้ง" }, 502);
      }
    } else if (file.type === "audio/mpeg" || file.type === "audio/mp3") {
      try {
        const cover = await extractTrackCover(env, objectKey);
        if (cover) {
          coverKey = `covers/${id}`;
          coverType = cover.type;
          await env.AUDIO.put(coverKey, cover.image, { httpMetadata: { contentType: coverType }, customMetadata: { trackId: id, purpose: "cover" } });
        }
      } catch (error) {
        console.error("embedded_cover_extract_failed", { id, message: String(error) });
      }
    }
    try {
      await env.DB.prepare(
        "INSERT INTO tracks (id, title, artist, album, genre, object_key, original_name, content_type, size_bytes, cover_key, cover_content_type, cover_checked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
      ).bind(id, title, artist, album, genre, objectKey, originalName, file.type || "application/octet-stream", file.size, coverKey, coverType).run();
    } catch (error) {
      await env.AUDIO.delete(objectKey);
      if (coverKey) await env.AUDIO.delete(coverKey);
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
    const knownGenre = await env.DB.prepare("SELECT name FROM genres WHERE name = ?").bind(genre).first();
    if (!title || title.length > 120 || !artist || artist.length > 120 || album.length > 120 || !knownGenre) {
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
    const track = await env.DB.prepare("SELECT object_key, cover_key FROM tracks WHERE id = ?").bind(trackMatch[1]).first();
    if (!track) return json({ error: "ไม่พบเพลงนี้" }, 404);
    await env.DB.prepare("DELETE FROM tracks WHERE id = ?").bind(trackMatch[1]).run();
    await env.AUDIO.delete(track.object_key);
    if (track.cover_key) await env.AUDIO.delete(track.cover_key);
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

