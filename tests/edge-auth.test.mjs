import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// 本番と同じく、CDK が埋め込む設定のプレースホルダを置き換えたコードを読み込む
const CONFIG = {
  issuer: "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_test",
  clientId: "client-id",
  hostedUiDomain: "auth.example.com",
};
const source = readFileSync(new URL("../infra/edge/auth.mjs", import.meta.url), "utf8");
const staged = mkdtempSync(join(tmpdir(), "golden-foundry-edge-test-"));
writeFileSync(
  join(staged, "index.mjs"),
  source.replace('"__GOLDEN_FOUNDRY_CONFIG__"', JSON.stringify(CONFIG)),
);
const { handler } = await import(join(staged, "index.mjs"));
after(() => rmSync(staged, { recursive: true, force: true }));

const DOMAIN = "d111111abcdef8.cloudfront.net";

function viewerRequest(uri, { querystring = "", cookies = [] } = {}) {
  const headers = { host: [{ key: "Host", value: DOMAIN }] };
  if (cookies.length > 0) {
    headers.cookie = [{ key: "Cookie", value: cookies.join("; ") }];
  }
  return { Records: [{ cf: { request: { uri, querystring, headers } } }] };
}

function setCookies(response) {
  return new Map(
    (response.headers["set-cookie"] ?? []).map(({ value }) => {
      const pair = value.split(";")[0];
      const index = pair.indexOf("=");
      return [pair.slice(0, index), pair.slice(index + 1)];
    }),
  );
}

test("ログイン開始で code_challenge を送り、検証用の値を Cookie に置く", async () => {
  const response = await handler(viewerRequest("/"));
  assert.equal(response.status, "302");

  const location = new URL(response.headers.location[0].value);
  const verifier = setCookies(response).get("gf_pkce");
  assert.ok(verifier);
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    location.searchParams.get("code_challenge"),
    createHash("sha256").update(verifier).digest("base64url"),
  );
});

test("検証用の Cookie が無いコールバックはトークンに交換しない", async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("{}", { status: 400 }),
  );
  const response = await handler(
    viewerRequest("/auth/callback", {
      querystring: "code=abc&state=nonce.Lw",
      cookies: ["gf_state=nonce"],
    }),
  );
  assert.equal(response.status, "401");
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("トークンの交換に code_verifier を付ける", async (t) => {
  let tokenRequestBody = null;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    tokenRequestBody = new URLSearchParams(init.body);
    return new Response("{}", { status: 400 });
  });
  await handler(
    viewerRequest("/auth/callback", {
      querystring: "code=abc&state=nonce.Lw",
      cookies: ["gf_state=nonce", "gf_pkce=the-verifier"],
    }),
  );
  assert.equal(tokenRequestBody?.get("code_verifier"), "the-verifier");
});
