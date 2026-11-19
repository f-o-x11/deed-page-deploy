// Find the build output folder of common static-site generators.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const exists = (root, rel) => existsSync(path.join(root, rel));
const isDir = (root, rel) => {
  try {
    return statSync(path.join(root, rel)).isDirectory();
  } catch {
    return false;
  }
};
const read = (root, rel) => {
  try {
    return readFileSync(path.join(root, rel), "utf8");
  } catch {
    return "";
  }
};
const anyOf = (root, names) => names.find((n) => exists(root, n));

function pkgDeps(root) {
  try {
    const pkg = JSON.parse(read(root, "package.json") || "{}");
    return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  } catch {
    return {};
  }
}

/**
 * Each rule names a generator, how to recognise its project, and where it writes the build.
 * Order matters: more specific config files come first.
 */
export const GENERATORS = [
  {
    id: "docusaurus",
    name: "Docusaurus",
    match: (r) => anyOf(r, ["docusaurus.config.js", "docusaurus.config.ts", "docusaurus.config.mjs", "docusaurus.config.cjs"]),
    out: () => ["build"],
  },
  {
    id: "vitepress",
    name: "VitePress",
    match: (r) => (isDir(r, ".vitepress") ? ".vitepress" : isDir(r, "docs/.vitepress") ? "docs/.vitepress" : null),
    out: (r) => [isDir(r, "docs/.vitepress") ? "docs/.vitepress/dist" : ".vitepress/dist", ".vitepress/dist", "docs/.vitepress/dist"],
  },
  {
    id: "astro",
    name: "Astro",
    match: (r) => anyOf(r, ["astro.config.mjs", "astro.config.ts", "astro.config.js", "astro.config.mts", "astro.config.cjs"]),
    out: () => ["dist"],
  },
  {
    id: "eleventy",
    name: "Eleventy",
    match: (r) =>
      anyOf(r, [".eleventy.js", "eleventy.config.js", "eleventy.config.mjs", "eleventy.config.cjs", "eleventy.config.ts"]) ||
      (pkgDeps(r)["@11ty/eleventy"] ? "package.json (@11ty/eleventy)" : null),
    out: () => ["_site"],
  },
  {
    id: "hexo",
    name: "Hexo",
    match: (r) => (pkgDeps(r).hexo ? "package.json (hexo)" : null),
    out: () => ["public"],
  },
  {
    id: "mkdocs",
    name: "MkDocs",
    match: (r) => anyOf(r, ["mkdocs.yml", "mkdocs.yaml"]),
    out: () => ["site"],
  },
  {
    id: "hugo",
    name: "Hugo",
    match: (r) => {
      const direct = anyOf(r, ["hugo.toml", "hugo.yaml", "hugo.yml", "hugo.json"]);
      if (direct) return direct;
      const cfg = anyOf(r, ["config.toml", "config.yaml", "config.yml"]);
      if (cfg && /baseURL/.test(read(r, cfg)) && (isDir(r, "content") || isDir(r, "layouts") || isDir(r, "themes"))) return cfg;
      return null;
    },
    out: () => ["public"],
  },
  {
    id: "zola",
    name: "Zola",
    match: (r) => {
      const cfg = anyOf(r, ["config.toml", "zola.toml"]);
      return cfg && /^\s*base_url\s*=/m.test(read(r, cfg)) ? cfg : null;
    },
    out: () => ["public"],
  },
  {
    id: "jekyll",
    name: "Jekyll",
    match: (r) => {
      if (/jekyll/i.test(read(r, "Gemfile"))) return "Gemfile (jekyll)";
      return anyOf(r, ["_config.yml", "_config.yaml"]) && !pkgDeps(r).hexo ? "_config.yml" : null;
    },
    out: () => ["_site"],
  },
];

/** Common output folders, tried in order when no generator is recognised. */
export const FALLBACK_DIRS = ["dist", "build", "public", "_site", "site", "out", "www"];

/**
 * @param {string} root project folder
 * @returns {{ dir: string, generator: string | null, reason: string } | null}
 */
export function detectOutputDir(root = process.cwd()) {
  for (const g of GENERATORS) {
    const hit = g.match(root);
    if (!hit) continue;
    for (const rel of g.out(root)) {
      if (isDir(root, rel)) return { dir: path.join(root, rel), generator: g.id, reason: `${g.name} project (${hit}) writes to ${rel}/` };
    }
    // Recognised the project but it is not built yet.
    return { dir: path.join(root, g.out(root)[0]), generator: g.id, reason: `${g.name} project (${hit}); ${g.out(root)[0]}/ does not exist yet. Run the build first.`, missing: true };
  }
  for (const rel of FALLBACK_DIRS) {
    if (exists(root, path.join(rel, "index.html"))) return { dir: path.join(root, rel), generator: null, reason: `found ${rel}/index.html` };
  }
  if (exists(root, "index.html")) return { dir: root, generator: null, reason: "found index.html in the project folder" };
  return null;
}
