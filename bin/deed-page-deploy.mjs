#!/usr/bin/env node
import path from "node:path";
import { appendFileSync } from "node:fs";
import { deploy, deleteSite, detectOutputDir, loadToken, saveToken, tokenFile, redact, VERSION, DeedPageError } from "../src/index.mjs";

const HELP = `deed-page-deploy ${VERSION}: publish a static build folder to https://<slug>.deed.page/

Usage:
  deed-page-deploy [--dir <folder>] [--slug <slug>] [options]
  deed-page-deploy detect [--cwd <project>]
  deed-page-deploy delete <slug>

With no --dir it looks for the build output of Hugo, Docusaurus, Eleventy, Astro,
VitePress, Jekyll, MkDocs, Zola and Hexo, then dist/, build/, public/, _site/, site/, out/.
Build your site first; this tool only uploads.

Options:
  --dir <folder>     Folder (or single .html file) to publish
  --cwd <folder>     Project folder used for auto-detection (default: current folder)
  --slug <slug>      Site name: https://<slug>.deed.page/. Reuse it to update the site.
  --spa              Serve index.html for unknown paths (single-page apps)
  --ref <tag>        Attribution tag sent as ?ref= (default deed-page-deploy)
  --client <name>    X-Client label (default deed-page-deploy/${VERSION})
  --origin <url>     API origin (default https://deed.page)
  --json             Print the result as JSON (the token is never printed)
  --no-save          Do not save a newly minted token
  -h, --help         Show help         -v, --version   Show version

Token: DEED_PAGE_TOKEN (or DEEDPAGE_TOKEN), else ${tokenFile()}.
The first publish without a token creates one and saves it there (mode 600).
In CI a token is required, so a new token is never lost in a log.
Docs: https://deed.page/docs`;

function parse(argv) {
  const out = { _: [], f: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.f.help = true;
    else if (a === "-v" || a === "--version") out.f.version = true;
    else if (a === "--spa" || a === "--json" || a === "--no-save") out.f[a.slice(2)] = true;
    else if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      out.f[k] = inline !== undefined ? inline : argv[++i];
    } else out._.push(a);
  }
  return out;
}

const env = process.env;
const inCI = env.CI === "true" || env.GITHUB_ACTIONS === "true";

function ghOutput(pairs) {
  if (!env.GITHUB_OUTPUT) return;
  for (const [k, v] of Object.entries(pairs)) if (v != null) appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

async function main() {
  const { _, f } = parse(process.argv.slice(2));
  if (f.version) return console.log(VERSION);
  if (f.help) return console.log(HELP);
  const origin = f.origin || env.DEED_PAGE_URL || undefined;
  const token = loadToken(undefined, env);

  if (_[0] === "detect") {
    const hit = detectOutputDir(path.resolve(f.cwd || "."));
    if (!hit) {
      console.error("No build folder found. Pass --dir.");
      process.exitCode = 1;
      return;
    }
    console.log(f.json ? JSON.stringify(hit) : `${hit.dir}\n${hit.reason}`);
    if (hit.missing) process.exitCode = 1;
    return;
  }

  if (_[0] === "delete") {
    const slug = _[1] || f.slug;
    const res = await deleteSite({ slug, token, origin, client: f.client });
    console.log(f.json ? JSON.stringify(res) : `Deleted ${slug}`);
    return;
  }

  let dir = f.dir || _[0];
  let reason = "--dir";
  if (!dir) {
    const hit = detectOutputDir(path.resolve(f.cwd || "."));
    if (!hit) throw new DeedPageError("No build folder found (dist, build, public, _site, site, out). Build your site, then pass --dir <folder>.");
    if (hit.missing) throw new DeedPageError(hit.reason);
    dir = hit.dir;
    reason = hit.reason;
  }
  if (!token && inCI) {
    throw new DeedPageError(
      "No token. In CI, set DEED_PAGE_TOKEN from a secret. Get one by running `npx deed-page-deploy` once on your machine; it saves the token to ~/.config/deed-page/token.",
    );
  }
  if (!f.json) console.error(`Publishing ${path.relative(process.cwd(), dir) || "."} (${reason})`);
  const res = await deploy({ dir, slug: f.slug, token, origin, ref: f.ref, client: f.client, spa: Boolean(f.spa) });
  let saved = null;
  if (res.minted) {
    saved = f["no-save"] ? null : saveToken(res.token, env);
  }
  ghOutput({ url: res.url, slug: res.slug, version: res.version });
  if (f.json) {
    const { token: _t, ...rest } = res;
    console.log(JSON.stringify({ ...rest, token_saved_to: saved }, null, 2));
  } else {
    console.error(`${res.files} files, ${(res.bytes / 1024).toFixed(1)} KiB, ${res.uploaded} uploaded, version ${res.version}`);
    if (res.minted) {
      console.error(saved ? `New owner token saved to ${saved} (mode 600). Keep it: it is the only key to update or delete this site.` : "New owner token was not saved (--no-save).");
      console.error(`Next time: deed-page-deploy --slug ${res.slug}`);
    }
    console.log(res.url);
  }
}

main().catch((err) => {
  console.error(redact(err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});
