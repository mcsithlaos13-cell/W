(() => {
  const storageKey = 'laos-remix-visitor-id';
  let memoryId = '';

  function makeId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function visitorId() {
    if (memoryId) return memoryId;
    try {
      memoryId = localStorage.getItem(storageKey) || makeId();
      localStorage.setItem(storageKey, memoryId);
    } catch {
      memoryId = makeId();
    }
    return memoryId;
  }

  async function updateStats() {
    try {
      const response = await fetch('/api/visitors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visitor_id: visitorId() }),
        cache: 'no-store',
      });
      if (!response.ok) return;
      const stats = await response.json();
      const total = document.querySelector('#visitorTotal');
      const online = document.querySelector('#visitorOnline');
      if (total) total.textContent = Number(stats.visitors || 0).toLocaleString('th-TH');
      if (online) online.textContent = Number(stats.online || 0).toLocaleString('th-TH');
    } catch { /* visitor stats are optional and should not disrupt the page */ }
  }

  updateStats();
  setInterval(() => { if (!document.hidden) updateStats(); }, 30000);
})();
