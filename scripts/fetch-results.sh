#!/usr/bin/env bash
#
# 評価ジョブの進捗を確認し、完了していれば結果を手元へ同期する。
#
# 使い方:
#   JOB_NAME=golden-eval-judge-20260802-120000 ./scripts/fetch-results.sh
#
# 環境変数:
#   JOB_NAME     ジョブ名または ARN (必須)
#   AWS_REGION   対象リージョン。AWS CLI がそのまま解釈する
#   AWS_PROFILE  対象プロファイル。同上
#   OUTPUT_DIR   結果の保存先 (既定: dist/results)
set -euo pipefail

OUTPUT_DIR="${OUTPUT_DIR:-dist/results}"

if [[ -z "${JOB_NAME:-}" ]]; then
  echo "JOB_NAME にジョブ名または ARN を指定してください。" >&2
  exit 1
fi

for tool in aws jq; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "${tool} が必要です。" >&2
    exit 1
  fi
done

JOB="$(aws bedrock get-evaluation-job \
  --job-identifier "${JOB_NAME}" \
  --output json)"

STATUS="$(jq -r '.status' <<< "${JOB}")"
echo "ステータス: ${STATUS}"
jq -r '"作成日時: \(.creationTime)"' <<< "${JOB}"

case "${STATUS}" in
  Completed)
    ;;
  Failed)
    echo "失敗理由:"
    jq -r '(.failureMessages // []) | if length == 0 then "  (メッセージなし)" else .[] | "  \(.)" end' <<< "${JOB}"
    exit 1
    ;;
  *)
    echo "まだ完了していません。しばらく待ってから再実行してください。"
    exit 0
    ;;
esac

OUTPUT_URI="$(jq -r '.outputDataConfig.s3Uri' <<< "${JOB}")"
if [[ -z "${OUTPUT_URI}" || "${OUTPUT_URI}" == "null" ]]; then
  echo "出力先 S3 URI を取得できませんでした。" >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"
echo "結果を同期しています: ${OUTPUT_URI} -> ${OUTPUT_DIR}"
aws s3 sync "${OUTPUT_URI}" "${OUTPUT_DIR}"

echo ""
echo "同期が完了しました。"
echo "  結果ファイル: ${OUTPUT_DIR}"
echo "  カスタムメトリクスの定義は出力先の custom_metrics 配下に保存されます。"
