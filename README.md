# deed-page-deploy

Publish a static site build to a permanent `https://<slug>.deed.page/` URL from your terminal or CI. It finds the build folder of Hugo, Docusaurus, Eleventy, Astro, VitePress, Jekyll, MkDocs, Zola and Hexo on its own, uploads only files that changed, and prints the live URL.

[deed.page](https://deed.page/?ref=deed-page-deploy) is static hosting operated by Avatar 8 LLC. No account or email is needed: the first publish creates an owner token.

## Install

```sh
npx deed-page-deploy --slug my-docs
```

Node.js 18 or later. No dependencies.

## Example

```sh
hugo                                 # or: npm run build, mkdocs build, zola build, ...
npx deed-page-deploy --slug my-docs
# Publishing public (Hugo project (hugo.toml) writes to public/)
# 42 files, 812.4 KiB, 42 uploaded, version v1
# New owner token saved to ~/.config/deed-page/token (mode 600). Keep it: ...
# https://my-docs.deed.page/
```

Run the same command again to publish a new version of the same site. Pass `--dir <folder>` to skip detection.

| Generator | Detected by | Folder published |
| --- | --- | --- |
| Hugo | `hugo.toml` (or `config.toml` with `baseURL`) | `public/` |
| Docusaurus | `docusaurus.config.*` | `build/` |
| Eleventy | `eleventy.config.*`, `.eleventy.js`, or `@11ty/eleventy` in package.json | `_site/` |
| Astro | `astro.config.*` | `dist/` |
| VitePress | `.vitepress/` or `docs/.vitepress/` | `.vitepress/dist/` |
| Jekyll | `Gemfile` with jekyll, or `_config.yml` | `_site/` |
| MkDocs | `mkdocs.yml` | `site/` |
| Zola | `config.toml` with `base_url` | `public/` |
| Hexo | `hexo` in package.json | `public/` |
| Anything else | first of `dist/`, `build/`, `public/`, `_site/`, `site/`, `out/` with an `index.html` | |

`npx deed-page-deploy detect` prints the folder it would publish.

## Options

```
--dir <folder>   folder or single .html file to publish
--slug <slug>    site name; reuse it to update the site
--spa            serve index.html for unknown paths
--cwd <folder>   project folder for detection
--json           machine-readable result (the token is never printed)
--no-save        do not save a newly minted token
deed-page-deploy delete <slug>
```

## Token

The token is read from `DEED_PAGE_TOKEN` (or `DEEDPAGE_TOKEN`), then `~/.config/deed-page/token`. A first publish without one creates a token and saves it there with mode 600. It is never printed. This is the same file the `deed-page` CLI uses.

In CI the tool refuses to mint a token, so a new one is never lost in a log. Run it once locally, then store the token as a secret:

```sh
gh secret set DEED_PAGE_TOKEN < ~/.config/deed-page/token
```

## GitHub Actions

Use [Deploy to deed.page](https://github.com/f-o-x11/deploy-to-deed-page):

```yaml
- uses: f-o-x11/deploy-to-deed-page@v1
  with:
    token: ${{ secrets.DEED_PAGE_TOKEN }}
    slug: my-docs
```

## Library

```js
import { deploy, detectOutputDir } from "deed-page-deploy";
const { url } = await deploy({ dir: "dist", slug: "my-docs", token: process.env.DEED_PAGE_TOKEN });
```

Uploads use the manifest flow (`POST /v1/uploads`, then the missing blobs, then finalize), so a site is limited by its plan size, not by a single request. API docs: https://deed.page/docs.

## Support

ops@avatar33.com. MIT license, Avatar 8 LLC.
