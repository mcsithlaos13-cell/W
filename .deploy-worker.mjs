import { readFile, writeFile } from 'node:fs/promises';
const root = process.cwd();
const worker = await readFile(`${root}/src/index.js`, 'utf8');
const pages = {};
for (const [route, file] of Object.entries({
  '/': 'index.html',
  '/index.html': 'index.html',
  '/members.html': 'members.html',
  '/upload.html': 'upload.html',
  '/creators.html': 'creators.html',
})) pages[route] = await readFile(`${root}/public/${file}`, 'utf8');
const marker = '    return env.ASSETS.fetch(request);';
if (!worker.includes(marker)) throw new Error('Worker static fallback marker is missing');
const routeCode = `    const pages = ${JSON.stringify(pages)};\n    const page = pages[url.pathname];\n    if (page) return new Response(request.method === "HEAD" ? null : page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });\n    return env.ASSETS.fetch(request);`;
await writeFile(`${root}/worker-deploy.js`, worker.replace(marker, routeCode), 'utf8');
console.log(`Prepared Worker upload: ${(await readFile(`${root}/worker-deploy.js`, 'utf8')).length} characters`);
