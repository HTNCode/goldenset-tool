/**
 * 取り込み用 CSV の読み取り。
 *
 * 外部から受け取るデータなので、区切り文字や引用符の扱いは RFC 4180 に沿わせ、
 * 列の過不足や制御文字は行単位で弾いて呼び出し側へ理由を返す。
 */

/** 取り込みに使う列。ヘッダー名は大文字小文字とスペースを無視して照合する */
const COLUMN_ALIASES = {
  prompt: ["prompt", "question", "質問"],
  expectedAnswer: ["referenceresponse", "expectedanswer", "answer", "期待回答", "期待される回答"],
  category: ["category", "カテゴリ", "カテゴリー"],
};

const VALID_CATEGORIES = new Set(["standard", "edge", "safety"]);

function normalizeHeader(value) {
  return value.trim().toLowerCase().replaceAll(/\s+/g, "");
}

/**
 * CSV 文字列を行と列の二次元配列にする。
 * 引用符の中の改行とカンマ、二重引用符によるエスケープを解釈する。
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let index = 0;

  // BOM 付きで書き出す表計算ソフトが多いので先頭で落とす
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  while (index < source.length) {
    const char = source[index];

    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\r") {
      index += 1;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function resolveColumns(header) {
  const normalized = header.map(normalizeHeader);
  const columns = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    const position = normalized.findIndex((name) => aliases.includes(name));
    if (position !== -1) {
      columns[key] = position;
    }
  }
  return columns;
}

function cell(row, position) {
  if (position === undefined) return "";
  return (row[position] ?? "").trim();
}

/**
 * CSV をレビューキューへ流せる形に変換する。
 * 承認前の候補として扱うため、状態は pending から始める。
 */
export function toCandidates(text) {
  const rows = parseCsv(text).filter((row) => row.some((value) => value.trim().length > 0));
  if (rows.length === 0) {
    return { candidates: [], errors: ["中身が空です。"] };
  }

  const columns = resolveColumns(rows[0]);
  if (columns.prompt === undefined) {
    return {
      candidates: [],
      errors: ["質問の列が見つかりません。ヘッダーに prompt / question / 質問 のいずれかが必要です。"],
    };
  }

  const candidates = [];
  const errors = [];

  for (let index = 1; index < rows.length; index += 1) {
    const lineNumber = index + 1;
    const prompt = cell(rows[index], columns.prompt);
    if (prompt.length === 0) {
      errors.push(`${lineNumber} 行目: 質問が空です。`);
      continue;
    }

    const rawCategory = cell(rows[index], columns.category).toLowerCase();
    candidates.push({
      id: crypto.randomUUID(),
      category: VALID_CATEGORIES.has(rawCategory) ? rawCategory : "standard",
      prompt,
      expectedAnswer: cell(rows[index], columns.expectedAnswer),
      checks: [],
      status: "pending",
      source: "csv",
      updatedAt: new Date().toISOString(),
    });
  }

  return { candidates, errors };
}
