const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "src", "index.js");
const publicPath = path.join(root, "public");
const outputPath = path.join(root, "worker-deploy.js");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function collectAssets(directory, prefix = "") {
  const assets = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    const relativePath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(assets, collectAssets(filePath, relativePath));
    else {
      const route = relativePath === "index.html" ? "/" : `/${relativePath}`;
      const extension = path.extname(entry.name).toLowerCase();
      assets[route] = {
        body: fs.readFileSync(filePath, "utf8"),
        contentType: contentTypes[extension] || "application/octet-stream",
      };
    }
  }
  return assets;
}

const source = fs.readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");
const fallback = "    return env.ASSETS.fetch(request);\n  },\n};";
if (!source.includes(fallback)) throw new Error("Worker asset fallback was not found");

const inlineAssets = JSON.stringify(collectAssets(publicPath));
const replacement = `    const pages = ${inlineAssets};\n    const page = pages[url.pathname];\n    if (page) return new Response(request.method === "HEAD" ? null : page.body, { headers: { "content-type": page.contentType, "cache-control": "no-store" } });\n    return env.ASSETS.fetch(request);\n  },\n};`;
fs.writeFileSync(outputPath, source.replace(fallback, replacement));
console.log(`Built ${path.relative(root, outputPath)} with ${Object.keys(collectAssets(publicPath)).length} static assets.`);
