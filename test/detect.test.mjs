import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectOutputDir } from "../src/detect.mjs";

function project(files) {
  const root = mkdtempSync(path.join(tmpdir(), "dpd-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return root;
}

const cases = [
  ["hugo", { "hugo.toml": "baseURL = 'https://x/'", "public/index.html": "x" }, "public"],
  ["hugo", { "config.toml": "baseURL = 'https://x/'", "content/a.md": "a", "public/index.html": "x" }, "public"],
  ["docusaurus", { "docusaurus.config.ts": "", "build/index.html": "x" }, "build"],
  ["eleventy", { "eleventy.config.js": "", "_site/index.html": "x" }, "_site"],
  ["eleventy", { "package.json": JSON.stringify({ devDependencies: { "@11ty/eleventy": "^3" } }), "_site/index.html": "x" }, "_site"],
  ["astro", { "astro.config.mjs": "", "dist/index.html": "x" }, "dist"],
  ["vitepress", { "docs/.vitepress/config.mts": "", "docs/.vitepress/dist/index.html": "x" }, "docs/.vitepress/dist"],
  ["vitepress", { ".vitepress/config.js": "", ".vitepress/dist/index.html": "x" }, ".vitepress/dist"],
  ["jekyll", { "_config.yml": "title: x", "Gemfile": "gem 'jekyll'", "_site/index.html": "x" }, "_site"],
  ["mkdocs", { "mkdocs.yml": "site_name: x", "site/index.html": "x" }, "site"],
  ["zola", { "config.toml": 'base_url = "https://x"', "public/index.html": "x" }, "public"],
  ["hexo", { "_config.yml": "title: x", "package.json": JSON.stringify({ dependencies: { hexo: "^7" } }), "public/index.html": "x" }, "public"],
];

for (const [gen, files, out] of cases) {
  test(`detects ${gen} -> ${out}`, () => {
    const root = project(files);
    const hit = detectOutputDir(root);
    assert.equal(hit.generator, gen);
    assert.equal(hit.dir, path.join(root, out));
    assert.ok(!hit.missing);
  });
}

test("reports a recognised project that is not built yet", () => {
  const hit = detectOutputDir(project({ "mkdocs.yml": "site_name: x" }));
  assert.equal(hit.generator, "mkdocs");
  assert.equal(hit.missing, true);
  assert.match(hit.reason, /Run the build first/);
});

test("falls back to common folders with an index.html", () => {
  const root = project({ "out/index.html": "x", "dist/readme.txt": "no index here" });
  const hit = detectOutputDir(root);
  assert.equal(hit.generator, null);
  assert.equal(hit.dir, path.join(root, "out"));
});

test("returns null when nothing is found", () => {
  assert.equal(detectOutputDir(project({ "README.md": "x" })), null);
});
