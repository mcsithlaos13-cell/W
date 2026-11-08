# คลื่น — คลังเพลงอิสระ

เว็บแชร์เพลงที่ทำงานบน Cloudflare Workers ใช้ D1 เก็บข้อมูลเพลง และ R2 เก็บไฟล์เสียง

## ระบบที่ใช้งาน

- Worker: `khlun-music`
- D1: `khlun-music` (binding `DB`)
- R2: `khlun-music-audio` (binding `AUDIO`)
- ไฟล์หน้าเว็บ: `public/`
- ขนาดไฟล์เสียงที่อัปโหลดได้: 20 MB ต่อเพลง
- จำกัดการอัปโหลดไว้ 5 เพลงต่อเครือข่ายต่อวัน, 20 เพลงต่อวันทั้งเว็บ และพื้นที่รวม 2 GB

### API

- `GET /api/tracks` — แสดงรายการเพลง
- `POST /api/tracks` — อัปโหลดไฟล์เสียงพร้อมรายละเอียดสำหรับผู้เข้าชมทั่วไป
- `GET /api/audio/:id` — เล่นไฟล์เสียง
- `GET /api/audio/:id?download=1` — ดาวน์โหลดไฟล์เสียง
- `DELETE /api/tracks/:id` — ลบเพลง (ต้องใช้รหัสผู้ดูแล)
- `GET /api/health` — ตรวจสถานะ Worker และ D1

## พัฒนาและเผยแพร่

ตั้งค่า Wrangler ตามไฟล์ `wrangler.jsonc` และให้บัญชี Cloudflare เข้าถึง Worker, D1 และ R2 ที่ระบุไว้ จากนั้นใช้คำสั่ง:

```sh
npx wrangler d1 migrations apply khlun-music --remote
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

การอัปโหลดสาธารณะไม่ต้องใช้ token ระบบยังเก็บ `ADMIN_TOKEN` ไว้สำหรับการลบเพลงผ่าน API ฝั่งผู้ดูแล และใช้สร้างค่าแฮช IP สำหรับจำกัดจำนวนอัปโหลด อย่าเปิดเผยค่านี้

ในเครื่องให้สร้างไฟล์ `.dev.vars` ที่มี `ADMIN_TOKEN="รหัสผู้ดูแลของคุณ"` ก่อนใช้ `npx wrangler dev` ห้าม commit ไฟล์นี้

การเปลี่ยน schema ใหม่ให้เพิ่มไฟล์ SQL ลำดับถัดไปใน `migrations/` แล้วใช้คำสั่ง migrations ด้านบน

