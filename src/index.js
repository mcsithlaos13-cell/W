const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const ALLOWED_GENRES = new Set(["ฟังสบาย", "อินดี้ป๊อป", "อะคูสติก", "อื่น ๆ"]);

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
    if (!(await isAdmin(request, env))) return json({ error: "รหัสผู้ดูแลไม่ถูกต้อง" }, 401);
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
    const id = crypto.randomUUID();
    const objectKey = `tracks/${id}`;
    const originalName = safeFilename(file.name);
    await env.AUDIO.put(objectKey, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
      customMetadata: { trackId: id },
    });
    try {
      await env.DB.prepare(
        "INSERT INTO tracks (id, title, artist, album, genre, object_key, original_name, content_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(id, title, artist, album, genre, objectKey, originalName, file.type || "application/octet-stream", file.size).run();
    } catch (error) {
      await env.AUDIO.delete(objectKey);
      console.error("track_insert_failed", { id, message: String(error) });
      return json({ error: "บันทึกข้อมูลเพลงไม่สำเร็จ" }, 500);
    }
    return json({ id, title, artist }, 201);
  }

  const trackMatch = url.pathname.match(/^\/api\/tracks\/([0-9a-f-]{36})$/i);
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

