import { toCandidates } from "./csv.js";

/**
 * S3 に置かれた CSV をレビューキューへ取り込む。
 *
 * ホストされた環境でのみ動く。ローカルで開いたときは設定ファイルと
 * AWS SDK のバンドルがないため、取り込みボタンごと隠す。
 */

const CONFIG_MODULE = "./config.js";
const AWS_CLIENT_MODULE = "../dist/app/aws-client.js";
const TOKEN_ENDPOINT = "/auth/token";

async function loadConfig() {
  try {
    const module = await import(CONFIG_MODULE);
    return module.CONFIG ?? null;
  } catch {
    return null;
  }
}

async function loadAwsClient() {
  try {
    return await import(AWS_CLIENT_MODULE);
  } catch {
    return null;
  }
}

/**
 * ID トークンは HttpOnly Cookie に入っていて JavaScript からは読めない。
 * Lambda@Edge が用意したエンドポイント経由で受け取る。
 */
async function fetchIdToken() {
  const response = await fetch(TOKEN_ENDPOINT, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error("ログイン情報を取得できませんでした。ページを再読み込みしてください。");
  }
  const body = await response.json();
  if (typeof body.idToken !== "string") {
    throw new Error("ログイン情報の形式が想定と異なります。");
  }
  return body.idToken;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(value) {
  const holder = document.createElement("div");
  holder.textContent = value;
  return holder.innerHTML;
}

export async function setupIntake(onImport) {
  const button = document.querySelector("#intake");
  const dialog = document.querySelector("#intakeDialog");
  const listNode = document.querySelector("#intakeList");
  const statusNode = document.querySelector("#intakeStatus");
  const closeButton = document.querySelector("#intakeClose");
  const uploadInput = document.querySelector("#intakeUpload");
  if (button === null || dialog === null || listNode === null) return;

  const config = await loadConfig();
  const aws = config === null ? null : await loadAwsClient();
  if (config === null || aws === null) {
    button.hidden = true;
    return;
  }

  let client = null;

  const setStatus = (message) => {
    statusNode.textContent = message;
  };

  const ensureClient = async () => {
    if (client !== null) return client;
    const idToken = await fetchIdToken();
    client = aws.createS3Client({
      region: config.region,
      identityPoolId: config.identityPoolId,
      userPoolId: config.userPoolId,
      idToken,
    });
    return client;
  };

  const refresh = async () => {
    setStatus("一覧を取得しています...");
    listNode.innerHTML = "";
    try {
      const s3 = await ensureClient();
      const objects = await aws.listCsvObjects(s3, config.intakeBucket);
      if (objects.length === 0) {
        setStatus("CSV がまだ置かれていません。下のフォームからアップロードするか、S3 に直接置いてください。");
        return;
      }
      setStatus(`${objects.length} 件の CSV が見つかりました。`);
      listNode.innerHTML = objects
        .map(
          (object) =>
            `<li><button data-key="${escapeHtml(object.key)}" class="outline">${escapeHtml(object.key)}</button><small>${formatSize(object.size)}　${escapeHtml(object.lastModified.slice(0, 19).replace("T", " "))}</small></li>`,
        )
        .join("");
    } catch (cause) {
      setStatus(`取得に失敗しました: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  const importObject = async (key) => {
    setStatus(`${key} を読み込んでいます...`);
    try {
      const s3 = await ensureClient();
      const text = await aws.readCsvObject(s3, config.intakeBucket, key);
      const { candidates, errors } = toCandidates(text);
      if (candidates.length === 0) {
        setStatus(`取り込める行がありませんでした。${errors.join(" ")}`);
        return;
      }
      onImport(candidates);
      const suffix = errors.length > 0 ? `　読み飛ばした行: ${errors.length} 件` : "";
      setStatus(`${candidates.length} 件をレビューキューに追加しました。${suffix}`);
    } catch (cause) {
      setStatus(`読み込みに失敗しました: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  const upload = async (file) => {
    setStatus(`${file.name} をアップロードしています...`);
    try {
      const s3 = await ensureClient();
      const key = `uploads/${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${file.name}`;
      await aws.putCsvObject(s3, config.intakeBucket, key, await file.text());
      setStatus(`${key} をアップロードしました。`);
      await refresh();
    } catch (cause) {
      setStatus(`アップロードに失敗しました: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  button.hidden = false;
  button.addEventListener("click", () => {
    dialog.showModal();
    void refresh();
  });
  closeButton?.addEventListener("click", () => dialog.close());
  listNode.addEventListener("click", (event) => {
    const target = event.target.closest("[data-key]");
    if (target === null) return;
    void importObject(target.dataset.key);
  });
  uploadInput?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    void upload(file);
    event.target.value = "";
  });
}
