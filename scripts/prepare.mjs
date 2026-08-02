#!/usr/bin/env node
/**
 * Golden Foundry がエクスポートした JSONL を Amazon Bedrock の評価ジョブに投入できる形へ検証・整形する。
 *
 * 使い方:
 *   node scripts/prepare.mjs --input golden-dataset.jsonl --output dist/dataset.jsonl
 *
 * 検証に落ちた場合は終了コード 1 を返し、出力ファイルを書かない。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

/** Bedrock が解釈するキー。これ以外は評価ジョブに渡す前に落とす */
const ALLOWED_KEYS = ["prompt", "referenceResponse", "category", "modelResponses"];

/** 自動評価ジョブ 1 件あたりのプロンプト数の上限 */
const MAX_PROMPTS = 1000;

const { values } = parseArgs({
  options: {
    input: { type: "string", default: "golden-dataset.jsonl" },
    output: { type: "string", default: "dist/dataset.jsonl" },
    "allow-duplicate-answers": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(
    [
      "使い方: node scripts/prepare.mjs [options]",
      "",
      "  --input <path>               入力 JSONL (既定: golden-dataset.jsonl)",
      "  --output <path>              出力 JSONL (既定: dist/dataset.jsonl)",
      "  --allow-duplicate-answers    期待回答の重複をエラーではなく警告として扱う",
      "  --help                       このヘルプを表示",
    ].join("\n"),
  );
  process.exit(0);
}

const errors = [];
const warnings = [];

function readLines(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    console.error(`入力ファイルを読めませんでした: ${path}`);
    console.error(String(cause));
    process.exit(1);
  }
  // Golden Foundry の CSV 出力に合わせて BOM が付いていても落とせるようにしておく
  return raw
    .replace(/^﻿/, "")
    .split("\n")
    .map((line, index) => ({ lineNumber: index + 1, text: line.trim() }))
    .filter((line) => line.text.length > 0);
}

function parseRecords(lines) {
  const records = [];
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line.text);
    } catch {
      errors.push(`${line.lineNumber} 行目: JSON として解釈できません。`);
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push(`${line.lineNumber} 行目: JSON オブジェクトではありません。`);
      continue;
    }
    records.push({ lineNumber: line.lineNumber, value: parsed });
  }
  return records;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateRecord({ lineNumber, value }) {
  if (!isNonEmptyString(value.prompt)) {
    errors.push(`${lineNumber} 行目: prompt が空、または文字列ではありません。`);
  }
  if ("referenceResponse" in value && !isNonEmptyString(value.referenceResponse)) {
    errors.push(`${lineNumber} 行目: referenceResponse が空、または文字列ではありません。`);
  }
  if ("category" in value && !isNonEmptyString(value.category)) {
    errors.push(`${lineNumber} 行目: category が空、または文字列ではありません。`);
  }
  const droppedKeys = Object.keys(value).filter((key) => !ALLOWED_KEYS.includes(key));
  if (droppedKeys.length > 0) {
    warnings.push(`${lineNumber} 行目: Bedrock が解釈しないキーを除去します (${droppedKeys.join(", ")})。`);
  }
}

function collectDuplicates(records, key) {
  const seen = new Map();
  for (const { lineNumber, value } of records) {
    const target = value[key];
    if (!isNonEmptyString(target)) continue;
    const normalized = target.trim();
    const lineNumbers = seen.get(normalized) ?? [];
    lineNumbers.push(lineNumber);
    seen.set(normalized, lineNumbers);
  }
  return [...seen.entries()].filter(([, lineNumbers]) => lineNumbers.length > 1);
}

function toBedrockRecord(value) {
  const record = {};
  for (const key of ALLOWED_KEYS) {
    if (key in value) {
      record[key] = value[key];
    }
  }
  return record;
}

const lines = readLines(values.input);
const records = parseRecords(lines);

if (records.length === 0) {
  errors.push("有効なレコードが 1 件もありません。");
}
if (records.length > MAX_PROMPTS) {
  errors.push(`レコードが ${records.length} 件あります。評価ジョブ 1 件あたりの上限は ${MAX_PROMPTS} 件です。`);
}

for (const record of records) {
  validateRecord(record);
}

for (const [prompt, lineNumbers] of collectDuplicates(records, "prompt")) {
  warnings.push(`質問が重複しています (${lineNumbers.join(", ")} 行目): ${prompt.slice(0, 40)}...`);
}

// 期待回答が使い回されているデータセットは、Correctness や Completeness の
// スコアが正解を測っていない状態になる。既定では投入前に止める。
const duplicateAnswers = collectDuplicates(records, "referenceResponse");
for (const [answer, lineNumbers] of duplicateAnswers) {
  const message = `期待回答が ${lineNumbers.length} 件で重複しています (${lineNumbers.join(", ")} 行目): ${answer.slice(0, 40)}...`;
  if (values["allow-duplicate-answers"]) {
    warnings.push(message);
  } else {
    errors.push(message);
  }
}

for (const warning of warnings) {
  console.warn(`警告: ${warning}`);
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`エラー: ${error}`);
  }
  if (duplicateAnswers.length > 0 && !values["allow-duplicate-answers"]) {
    console.error("");
    console.error("期待回答はレビューキューで 1 件ずつ実際の正解に書き換えてから再エクスポートしてください。");
    console.error("重複を承知のうえで投入する場合は --allow-duplicate-answers を付けてください。");
  }
  process.exit(1);
}

const output = records.map(({ value }) => JSON.stringify(toBedrockRecord(value))).join("\n");
mkdirSync(dirname(values.output), { recursive: true });
writeFileSync(values.output, `${output}\n`, "utf8");

const categories = new Map();
for (const { value } of records) {
  const category = isNonEmptyString(value.category) ? value.category : "(未設定)";
  categories.set(category, (categories.get(category) ?? 0) + 1);
}

console.log(`検証に成功しました: ${records.length} 件`);
for (const [category, count] of categories) {
  console.log(`  ${category}: ${count} 件`);
}
console.log(`出力: ${values.output}`);
