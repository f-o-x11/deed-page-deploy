// deed-page-deploy: upload a static build folder to https://<slug>.deed.page/
// No dependencies. Node 18+. Operated service: deed.page by Avatar 8 LLC (ops@avatar33.com).
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export { detectOutputDir, GENERATORS, FALLBACK_DIRS } from "./detect.mjs";

export const VERSION = "0.1.0";
export const DEFAULT_ORIGIN = "https://deed.page";
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;
const SKIP = new Set([".git", "node_modules", ".DS_Store", "Thumbs.db"]);

export class DeedPageError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = "DeedPageError";
    this.status = status;
    this.body = body;
    this.code = body && (body.code || body.error);
  }
}

export function tokenFile(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), ".config");
  return path.join(base, "deed-page", "token");
}

/** Token order: explicit, DEED_PAGE_TOKEN, DEEDPAGE_TOKEN, ~/.config/deed-page/token. */
export function loadToken(explicit, env = process.env) {
  for (const v of [explicit, env.DEED_PAGE_TOKEN, env.DEEDPAGE_TOKEN]) if (v && String(v).trim()) return String(v).trim();
  try {
    return readFileSync(tokenFile(env), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Save a newly minted token (dir 700, file 600). Never overwrites a different saved token. */
export function saveToken(token, env = process.env) {
  const file = tokenFile(env);
  let existing = "";
  try {
    existing = readFileSync(file, "utf8").trim();
  } catch {}
  const target = existing && existing !== token ? `${file}.new` : file;
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    chmodSync(path.dirname(target), 0o700);
  } catch {}
  writeFileSync(target, `${token}\n`, { mode: 0o600 });
  chmodSync(target, 0o600);
  return target;
}

export function redact(text) {
  return String(text).replace(/deed_[a-z]{2,4}_[A-Za-z0-9_-]+/g, "<redacted>");
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".map": "application/json", ".webmanifest": "application/manifest+json", ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".ico": "image/x-icon", ".pdf": "application/pdf", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".wasm": "application/wasm", ".mp4": "video/mp4", ".webm": "video/webm",
};
export const contentType = (p) => TYPES[path.extname(p).toLowerCase()] || "application/octet-stream";

/**
 * Read a folder (or one file) into [{ rel, size, sha256, type, data }].
 * A single .html file becomes index.html. Symlinks, .git and node_modules are skipped.
 */
export async function collectFiles(target) {
  const root = path.resolve(target);
  const info = await stat(root);
  const one = async (abs, rel) => {
    const data = await readFile(abs);
    if (data.length > MAX_FILE_BYTES) throw new DeedPageError(`${rel} is ${data.length} bytes; files over 100 MB are not uploaded.`);
    return { rel, size: data.length, sha256: createHash("sha256").update(data).digest("hex"), type: contentType(rel), data };
  };
  if (info.isFile()) {
    const base = path.basename(root);
    return [await one(root, /\.html?$/i.test(base) ? "index.html" : base)];
  }
  if (!info.isDirectory()) throw new DeedPageError(`Not a file or folder: ${target}`);
  const out = [];
  const walk = async (rel) => {
    const entries = await readdir(path.join(root, rel), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(next);
      else if (e.isFile()) out.push(await one(path.join(root, next), next));
    }
  };
  await walk("");
  if (!out.length) throw new DeedPageError(`No files found in ${target}`);
  return out;
}

async function fetchRetry(fetchImpl, url, init) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw new DeedPageError(`Network error: ${err && err.message ? err.message : err}`);
    }
    if ((res.status === 502 || res.status === 503) && attempt === 0) {
      await res.text().catch(() => "");
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    return res;
  }
}

async function json(res) {
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {}
  if (!res.ok || (body && body.ok === false)) {
    const msg = (body && (body.message_for_user || body.message || body.error)) || text.slice(0, 300) || `HTTP ${res.status}`;
    throw new DeedPageError(redact(msg), res.status, body);
  }
  if (!body) throw new DeedPageError("deed.page did not return JSON.", res.status);
  return body;
}

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

/**
 * Publish a folder as one new version of https://<slug>.deed.page/.
 * Uses the manifest upload (POST /v1/uploads, PUT missing blobs, finalize), so size is limited
 * only by the plan, and files already stored are not uploaded again.
 *
 * @param {object} opts
 * @param {string} opts.dir           folder or single file to publish
 * @param {string} [opts.slug]        site name; omit on a first publish to let deed.page pick one
 * @param {string} [opts.token]       owner bearer token; omit on a first publish to mint one
 * @param {string} [opts.origin]      API origin (default https://deed.page)
 * @param {string} [opts.ref]         attribution tag (default deed-page-deploy)
 * @param {string} [opts.client]      X-Client label
 * @param {boolean} [opts.spa]        single-page-app fallback to index.html
 * @param {typeof fetch} [opts.fetch]
 * @returns {Promise<{url:string, slug:string, version:string, files:number, bytes:number, uploaded:number, token?:string, minted:boolean, response:object}>}
 */
export async function deploy(opts = {}) {
  const { dir, slug, token, spa = false } = opts;
  if (!dir) throw new DeedPageError("dir is required");
  if (slug != null && slug !== "" && !SLUG_RE.test(slug)) {
    throw new DeedPageError(`Invalid slug "${slug}": 1-63 lowercase letters, digits and hyphens, no leading or trailing hyphen.`);
  }
  const origin = String(opts.origin || DEFAULT_ORIGIN).replace(/\/+$/, "");
  const ref = opts.ref || "deed-page-deploy";
  const client = opts.client || `deed-page-deploy/${VERSION}`;
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new DeedPageError("No fetch available. Use Node 18 or later.");

  const files = await collectFiles(dir);
  const manifest = { files: files.map((f) => ({ path: f.rel, sha256: f.sha256, size: f.size, content_type: f.type })) };
  if (slug) manifest.slug = slug;
  if (spa) manifest.spa = true;

  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "x-client": client,
    "user-agent": `deed-page-deploy/${VERSION}`,
    "idempotency-key": `dpd-${randomUUID()}`,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const planUrl = `${origin}/v1/uploads?ref=${encodeURIComponent(ref)}`;
  const plan = await json(await fetchRetry(fetchImpl, planUrl, { method: "POST", headers, body: JSON.stringify(manifest) }));

  const bySha = new Map(files.map((f) => [f.sha256, f]));
  const missing = (plan.missing || []).filter((m) => !m.stored);
  await pool(missing, UPLOAD_CONCURRENCY, async (m) => {
    const f = bySha.get(m.sha256);
    if (!f) throw new DeedPageError(`Server asked for unknown blob ${m.sha256}`);
    const up = m.upload || {};
    const res = await fetchRetry(fetchImpl, up.url, { method: up.method || "PUT", headers: up.headers || {}, body: f.data });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DeedPageError(`Upload of ${f.rel} failed (HTTP ${res.status}): ${redact(text.slice(0, 200))}`, res.status);
    }
    await res.arrayBuffer().catch(() => null);
  });

  if (!plan.finalize_url) throw new DeedPageError("Upload plan had no finalize_url.", 0, plan);
  const finHeaders = { accept: "application/json", "x-client": client };
  if (token) finHeaders.authorization = `Bearer ${token}`;
  const result = await json(await fetchRetry(fetchImpl, plan.finalize_url, { method: "POST", headers: finHeaders }));
  if (!result.url) throw new DeedPageError("Publish finished without a URL.", 0, result);
  const minted = typeof result.token === "string" && result.token ? result.token : null;
  return {
    url: result.url,
    slug: result.slug,
    version: result.version,
    files: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
    uploaded: missing.length,
    token: minted || undefined,
    minted: Boolean(minted),
    response: { ...result, token: minted ? "<minted>" : undefined },
  };
}

/** Delete a site you own. */
export async function deleteSite({ slug, token, origin, fetch: fetchImpl = globalThis.fetch, client } = {}) {
  if (!slug || !SLUG_RE.test(slug)) throw new DeedPageError("A valid slug is required.");
  if (!token) throw new DeedPageError("A token is required to delete a site.");
  const base = String(origin || DEFAULT_ORIGIN).replace(/\/+$/, "");
  const res = await fetchRetry(fetchImpl, `${base}/v1/sites/${encodeURIComponent(slug)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}`, accept: "application/json", "x-client": client || `deed-page-deploy/${VERSION}` },
  });
  return json(res);
}
