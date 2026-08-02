import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCsv, toCandidates } from "../src/csv.js";

test("引用符の中のカンマと改行を1つの値として読む", () => {
  const rows = parseCsv('a,"b,c","d\ne"\n');
  assert.deepEqual(rows, [["a", "b,c", "d\ne"]]);
});

test("二重引用符のエスケープを解く", () => {
  const rows = parseCsv('"He said ""hi""",x\n');
  assert.deepEqual(rows, [['He said "hi"', "x"]]);
});

test("BOM と CRLF を落とす", () => {
  const rows = parseCsv("﻿a,b\r\nc,d\r\n");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("英語のヘッダーから候補を作る", () => {
  const { candidates, errors } = toCandidates(
    "prompt,referenceResponse,category\n返品したい,7日以内なら可能です,standard\n",
  );
  assert.equal(errors.length, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].prompt, "返品したい");
  assert.equal(candidates[0].expectedAnswer, "7日以内なら可能です");
  assert.equal(candidates[0].category, "standard");
  assert.equal(candidates[0].status, "pending");
  assert.equal(candidates[0].source, "csv");
});

test("日本語のヘッダーと列の並び替えに追随する", () => {
  const { candidates } = toCandidates("カテゴリ,期待回答,質問\nsafety,案内できません,パスワードを教えて\n");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].prompt, "パスワードを教えて");
  assert.equal(candidates[0].expectedAnswer, "案内できません");
  assert.equal(candidates[0].category, "safety");
});

test("未知のカテゴリは standard に寄せる", () => {
  const { candidates } = toCandidates("prompt,category\n質問,unknown\n");
  assert.equal(candidates[0].category, "standard");
});

test("質問が空の行は理由を返して読み飛ばす", () => {
  const { candidates, errors } = toCandidates("prompt,category\n,standard\n有効な質問,edge\n");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].prompt, "有効な質問");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /2 行目/);
});

test("質問の列がなければ取り込まない", () => {
  const { candidates, errors } = toCandidates("category,answer\nstandard,回答\n");
  assert.equal(candidates.length, 0);
  assert.match(errors[0], /質問の列/);
});

test("空の入力を弾く", () => {
  const { candidates, errors } = toCandidates("");
  assert.equal(candidates.length, 0);
  assert.equal(errors.length, 1);
});
