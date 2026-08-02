import { createPublicKey, createVerify, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * CloudFront の viewer request で動く認証関数。
 *
 * Lambda@Edge は環境変数を持てないため、CDK が synth 時に次の行の
 * プレースホルダ（クオートを含む文字列全体）を設定オブジェクトへ置き換える。
 * CloudFront のドメイン名だけは関数より後に決まるので、ここには入れず
 * リクエストの Host ヘッダーから取る。
 */
const CONFIG = "__GOLDEN_FOUNDRY_CONFIG__";

const CALLBACK_PATH = "/auth/callback";
const SIGN_OUT_PATH = "/auth/signout";
const TOKEN_PATH = "/auth/token";
const ID_TOKEN_COOKIE = "gf_id_token";
const STATE_COOKIE = "gf_state";
const STATE_TTL_SECONDS = 600;

/** JWKS はキーが変わらないので、コンテナが生きている間は使い回す */
let cachedKeys = null;

function buildCookie(name, value, maxAgeSeconds) {
  return [
    `${name}=${value}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

function readCookie(headers, name) {
  const cookieHeaders = headers.cookie ?? [];
  for (const header of cookieHeaders) {
    for (const pair of header.value.split(";")) {
      const index = pair.indexOf("=");
      if (index === -1) continue;
      if (pair.slice(0, index).trim() === name) {
        return pair.slice(index + 1).trim();
      }
    }
  }
  return null;
}

/**
 * このディストリビューションのドメイン。CloudFront が付ける Host ヘッダーを使う。
 * 想定外の値を Location ヘッダーに入れないよう、ホスト名として妥当な文字だけ通す。
 */
function selfDomain(headers) {
  const host = headers.host?.[0]?.value;
  if (typeof host !== "string" || !/^[A-Za-z0-9.-]{1,253}$/.test(host)) {
    return null;
  }
  return host;
}

/**
 * ログイン後の戻り先。外部ドメインへ飛ばされないよう、単一のスラッシュで始まる
 * パスだけを許可する。"//evil.com" と "/\evil.com" はどちらもブラウザが
 * 外部オリジンとして解釈するため弾く。制御文字は Location ヘッダーに入れない。
 */
function sanitizeReturnPath(value) {
  if (typeof value !== "string" || value.length === 0) return "/";
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (/[\u0000-\u0020]/.test(value)) return "/";
  return value;
}

function redirect(location, cookies = []) {
  const headers = {
    location: [{ key: "Location", value: location }],
    "cache-control": [{ key: "Cache-Control", value: "no-store" }],
  };
  if (cookies.length > 0) {
    headers["set-cookie"] = cookies.map((value) => ({ key: "Set-Cookie", value }));
  }
  return { status: "302", statusDescription: "Found", headers };
}

function errorResponse(status, description, message) {
  return {
    status,
    statusDescription: description,
    headers: {
      "content-type": [{ key: "Content-Type", value: "text/plain; charset=utf-8" }],
      "cache-control": [{ key: "Cache-Control", value: "no-store" }],
    },
    body: message,
  };
}

function jsonResponse(payload) {
  return {
    status: "200",
    statusDescription: "OK",
    headers: {
      "content-type": [{ key: "Content-Type", value: "application/json; charset=utf-8" }],
      "cache-control": [{ key: "Cache-Control", value: "no-store" }],
    },
    body: JSON.stringify(payload),
  };
}

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url");
}

async function loadKeys() {
  if (cachedKeys !== null) return cachedKeys;
  const response = await fetch(`${CONFIG.issuer}/.well-known/jwks.json`);
  if (!response.ok) {
    throw new Error(`JWKS を取得できませんでした: ${response.status}`);
  }
  const jwks = await response.json();
  cachedKeys = new Map(
    jwks.keys.map((jwk) => [jwk.kid, createPublicKey({ key: jwk, format: "jwk" })]),
  );
  return cachedKeys;
}

/**
 * Cognito の ID トークンを検証する。
 * 署名（RS256）、発行者、対象クライアント、用途、有効期限をすべて確認する。
 */
async function verifyIdToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(decodeBase64Url(encodedHeader).toString("utf8"));
    payload = JSON.parse(decodeBase64Url(encodedPayload).toString("utf8"));
  } catch {
    return null;
  }

  if (header.alg !== "RS256") return null;

  const keys = await loadKeys();
  const key = keys.get(header.kid);
  if (key === undefined) return null;

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  if (!verifier.verify(key, decodeBase64Url(encodedSignature))) return null;

  if (payload.iss !== CONFIG.issuer) return null;
  if (payload.aud !== CONFIG.clientId) return null;
  if (payload.token_use !== "id") return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;

  return payload;
}

function hostedUiUrl(path, params) {
  return `https://${CONFIG.hostedUiDomain}${path}?${new URLSearchParams(params).toString()}`;
}

function startLogin(domain, returnPath) {
  // state は CSRF 対策の乱数と戻り先を連結し、Cookie 側の乱数と突き合わせる
  const nonce = randomBytes(16).toString("base64url");
  const encodedReturn = Buffer.from(sanitizeReturnPath(returnPath), "utf8").toString("base64url");
  const location = hostedUiUrl("/oauth2/authorize", {
    client_id: CONFIG.clientId,
    response_type: "code",
    scope: "openid",
    redirect_uri: `https://${domain}${CALLBACK_PATH}`,
    state: `${nonce}.${encodedReturn}`,
  });
  return redirect(location, [buildCookie(STATE_COOKIE, nonce, STATE_TTL_SECONDS)]);
}

function noncesMatch(expected, actual) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function handleCallback(request, domain) {
  const params = new URLSearchParams(request.querystring);
  const code = params.get("code");
  const state = params.get("state");
  if (code === null || state === null) {
    return errorResponse("401", "Unauthorized", "認可コードがありません。もう一度アクセスしてください。");
  }

  const separator = state.indexOf(".");
  if (separator === -1) {
    return errorResponse("401", "Unauthorized", "state の形式が不正です。");
  }
  const expectedNonce = readCookie(request.headers, STATE_COOKIE);
  if (expectedNonce === null || !noncesMatch(expectedNonce, state.slice(0, separator))) {
    return errorResponse("401", "Unauthorized", "state が一致しません。もう一度アクセスしてください。");
  }

  let returnPath = "/";
  try {
    returnPath = sanitizeReturnPath(decodeBase64Url(state.slice(separator + 1)).toString("utf8"));
  } catch {
    returnPath = "/";
  }

  // 認可コードとトークンの交換。値の連結は URLSearchParams に任せる
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CONFIG.clientId,
    code,
    redirect_uri: `https://${domain}${CALLBACK_PATH}`,
  });
  const response = await fetch(`https://${CONFIG.hostedUiDomain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    return errorResponse("401", "Unauthorized", "トークンの取得に失敗しました。");
  }
  const tokens = await response.json();
  if (typeof tokens.id_token !== "string") {
    return errorResponse("401", "Unauthorized", "ID トークンが返りませんでした。");
  }

  const claims = await verifyIdToken(tokens.id_token);
  if (claims === null) {
    return errorResponse("401", "Unauthorized", "ID トークンを検証できませんでした。");
  }

  const maxAge = Math.max(0, claims.exp - Math.floor(Date.now() / 1000));
  return redirect(`https://${domain}${returnPath}`, [
    buildCookie(ID_TOKEN_COOKIE, tokens.id_token, maxAge),
    buildCookie(STATE_COOKIE, "", 0),
  ]);
}

function handleSignOut(domain) {
  const location = hostedUiUrl("/logout", {
    client_id: CONFIG.clientId,
    logout_uri: `https://${domain}/`,
  });
  return redirect(location, [buildCookie(ID_TOKEN_COOKIE, "", 0)]);
}

export const handler = async (event) => {
  const request = event.Records[0].cf.request;
  const domain = selfDomain(request.headers);
  if (domain === null) {
    return errorResponse("400", "Bad Request", "Host ヘッダーが不正です。");
  }

  if (request.uri === CALLBACK_PATH) {
    return handleCallback(request, domain);
  }
  if (request.uri === SIGN_OUT_PATH) {
    return handleSignOut(domain);
  }

  // ID トークンは HttpOnly Cookie に入れてあり JavaScript からは読めない。
  // S3 を直接呼ぶために必要なので、検証したうえでここから渡す。
  if (request.uri === TOKEN_PATH) {
    const cookie = readCookie(request.headers, ID_TOKEN_COOKIE);
    if (cookie === null) {
      return errorResponse("401", "Unauthorized", "ログインしていません。");
    }
    const verified = await verifyIdToken(cookie);
    if (verified === null) {
      return errorResponse("401", "Unauthorized", "ログイン情報の有効期限が切れています。");
    }
    return jsonResponse({ idToken: cookie, expiresAt: verified.exp });
  }

  const token = readCookie(request.headers, ID_TOKEN_COOKIE);
  if (token === null) {
    return startLogin(domain, request.uri);
  }

  // 期限切れも改ざんもここで検知して、エッジからログインへ戻す
  const claims = await verifyIdToken(token);
  if (claims === null) {
    return startLogin(domain, request.uri);
  }

  return request;
};
