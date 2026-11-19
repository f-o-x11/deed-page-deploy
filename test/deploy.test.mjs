import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { deploy, deleteSite, collectFiles, saveToken, loadToken, redact } from "../src/index.mjs";

function site() {
  const root = mkdtempSync(path.join(tmpdir(), "dpd-site-"));
  mkdirSync(path.join(root, "assets"));
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, "index.html"), "<h1>hi</h1>");
  writeFileSync(path.join(root, "assets/app.css"), "body{}");
  writeFileSync(path.join(root, "assets/logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(root, ".git/HEAD"), "ref");
  return root;
}

function fakeServer({ present = [] } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method, url: u.pathname + u.search, headers: init.headers || {}, body: init.body });
    const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/v1/uploads" && init.method === "POST") {
      const m = JSON.parse(init.body);
      const missing = m.files
        .filter((f) => !present.includes(f.path))
        .map((f) => ({ sha256: f.sha256, paths: [f.path], upload: { url: `https://blob.test/${f.sha256}`, headers: { "x-up": "1" } } }));
      return reply(200, { ok: true, missing, present: [], finalize_url: "https://deed.test/v1/uploads/s1/finalize" });
    }
    if (u.host === "blob.test") {
      const sha = createHash("sha256").update(Buffer.from(init.body)).digest("hex");
      return sha === u.pathname.slice(1) ? new Response("", { status: 200 }) : new Response("bad", { status: 400 });
    }
    if (u.pathname.endsWith("/finalize")) {
      const auth = (init.headers || {}).authorization;
      return reply(200, { ok: true, url: "https://my-docs.deed.page/", slug: "my-docs", version: "v1", ...(auth ? {} : { token: "deed_tok_NEWSECRET123" }) });
    }
    if (u.pathname.startsWith("/v1/sites/") && init.method === "DELETE") return reply(200, { ok: true, deleted: u.pathname.split("/").pop() });
    return reply(404, { ok: false, message: "nope" });
  };
  return { fetch, calls };
}

test("collectFiles skips .git and hashes bytes", async () => {
  const files = await collectFiles(site());
  assert.deepEqual(files.map((f) => f.rel), ["assets/app.css", "assets/logo.png", "index.html"]);
  assert.equal(files.find((f) => f.rel === "assets/logo.png").type, "image/png");
});

test("a single html file becomes index.html", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dpd-one-"));
  writeFileSync(path.join(dir, "export.html"), "<p>x</p>");
  const files = await collectFiles(path.join(dir, "export.html"));
  assert.equal(files[0].rel, "index.html");
});

test("deploy: plan, upload missing blobs, finalize; mint on first publish", async () => {
  const srv = fakeServer({ present: ["assets/app.css"] });
  const res = await deploy({ dir: site(), slug: "my-docs", origin: "https://deed.test", ref: "gh-action", fetch: srv.fetch });
  assert.equal(res.url, "https://my-docs.deed.page/");
  assert.equal(res.uploaded, 2);
  assert.equal(res.minted, true);
  assert.equal(res.token, "deed_tok_NEWSECRET123");
  assert.ok(!JSON.stringify(res.response).includes("NEWSECRET"));
  const plan = srv.calls[0];
  assert.equal(plan.url, "/v1/uploads?ref=gh-action");
  assert.equal(JSON.parse(plan.body).slug, "my-docs");
  assert.equal(plan.headers.authorization, undefined);
  assert.equal(srv.calls.filter((c) => c.url.startsWith("/") && c.method === "PUT").length, 2);
});

test("deploy with a token sends Bearer on plan and finalize and mints nothing", async () => {
  const srv = fakeServer();
  const res = await deploy({ dir: site(), slug: "my-docs", token: "deed_tok_OLD", origin: "https://deed.test", fetch: srv.fetch });
  assert.equal(res.minted, false);
  assert.equal(srv.calls[0].headers.authorization, "Bearer deed_tok_OLD");
  assert.equal(srv.calls.at(-1).headers.authorization, "Bearer deed_tok_OLD");
});

test("rejects a bad slug before any request", async () => {
  const srv = fakeServer();
  await assert.rejects(deploy({ dir: site(), slug: "Bad_Slug", fetch: srv.fetch }), /Invalid slug/);
  assert.equal(srv.calls.length, 0);
});

test("server errors surface message_for_user with tokens redacted", async () => {
  const fetch = async () => new Response(JSON.stringify({ ok: false, message_for_user: "Limit hit for deed_tok_ABC", code: "quota_sites" }), { status: 403 });
  await assert.rejects(deploy({ dir: site(), slug: "x1", fetch }), (e) => e.status === 403 && e.code === "quota_sites" && !e.message.includes("ABC"));
});

test("deleteSite calls DELETE /v1/sites/<slug>", async () => {
  const srv = fakeServer();
  const res = await deleteSite({ slug: "my-docs", token: "t", origin: "https://deed.test", fetch: srv.fetch });
  assert.equal(res.deleted, "my-docs");
});

test("saveToken writes mode 600 and never overwrites a different token", () => {
  const home = mkdtempSync(path.join(tmpdir(), "dpd-home-"));
  const env = { XDG_CONFIG_HOME: home };
  const p = saveToken("deed_tok_A", env);
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(loadToken(undefined, env), "deed_tok_A");
  const p2 = saveToken("deed_tok_B", env);
  assert.ok(p2.endsWith(".new"));
  assert.equal(readFileSync(p, "utf8").trim(), "deed_tok_A");
  assert.equal(loadToken(undefined, { ...env, DEED_PAGE_TOKEN: "deed_tok_ENV" }), "deed_tok_ENV");
});

test("redact hides tokens", () => {
  assert.equal(redact("x deed_tok_abc-1 y deed_oat_z"), "x <redacted> y <redacted>");
});
