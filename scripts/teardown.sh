#!/usr/bin/env bash
#
# 指定した環境の AWS リソースをすべて削除する。
#
# 使い方:
#   ENV_NAME=dev ./scripts/teardown.sh
#
# 環境変数:
#   ENV_NAME     対象環境 (既定: dev)
#   AWS_REGION   対象リージョン。AWS CLI がそのまま解釈する
#   AWS_PROFILE  対象プロファイル。同上
#   KEEP_DATA    1 を指定するとバケットの中身を消さずに残す（スタック削除は失敗する）
#   YES          1 を指定すると確認を省略する
set -euo pipefail

ENV_NAME="${ENV_NAME:-dev}"
KEEP_DATA="${KEEP_DATA:-0}"
YES="${YES:-0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="${REPO_ROOT}/infra"

EVAL_STACK="GoldenFoundryEvalStack-${ENV_NAME}"
AUTH_STACK="GoldenFoundryAuthStack-${ENV_NAME}"
HOSTING_STACK="GoldenFoundryHostingStack-${ENV_NAME}"

for tool in aws jq bunx; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "${tool} が必要です。" >&2
    exit 1
  fi
done

echo "削除対象の環境: ${ENV_NAME}"
echo "  ${HOSTING_STACK}"
echo "  ${AUTH_STACK}"
echo "  ${EVAL_STACK}"
echo ""

if [[ "${YES}" != "1" ]]; then
  read -r -p "この環境のリソースをすべて削除します。よろしいですか (yes/no): " answer
  if [[ "${answer}" != "yes" ]]; then
    echo "中止しました。"
    exit 0
  fi
fi

stack_exists() {
  aws cloudformation describe-stacks --stack-name "$1" >/dev/null 2>&1
}

stack_output() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null || true
}

# 通常の s3 rm ではバージョンと削除マーカーが残り、バケットを削除できない。
# list-object-versions で両方を集めて消す。
empty_bucket() {
  local bucket="$1"
  if [[ -z "${bucket}" || "${bucket}" == "None" ]]; then
    return 0
  fi
  if ! aws s3api head-bucket --bucket "${bucket}" >/dev/null 2>&1; then
    echo "  バケットが見つかりません（削除済み）: ${bucket}"
    return 0
  fi
  echo "  バケットを空にしています: ${bucket}"
  while :; do
    local payload count
    payload="$(aws s3api list-object-versions --bucket "${bucket}" --max-keys 1000 --output json \
      | jq -c '{Objects: [(.Versions // []), (.DeleteMarkers // [])] | flatten | map({Key, VersionId})}')"
    count="$(jq '.Objects | length' <<< "${payload}")"
    if [[ "${count}" -eq 0 ]]; then
      break
    fi
    aws s3api delete-objects --bucket "${bucket}" --delete "${payload}" >/dev/null
    echo "    ${count} 件削除"
  done
}

destroy_stack() {
  local stack="$1"
  shift
  if ! stack_exists "${stack}"; then
    echo "  スタックがありません（削除済み）: ${stack}"
    return 0
  fi
  echo "  スタックを削除しています: ${stack}"
  (cd "${INFRA_DIR}" && bunx cdk destroy --force -c "env=${ENV_NAME}" "$@" "${stack}")
}

echo ""
echo "1. バケットの中身を削除します"
if [[ "${KEEP_DATA}" == "1" ]]; then
  echo "  KEEP_DATA=1 のためスキップします。中身が残っているとスタック削除は失敗します。"
else
  empty_bucket "$(stack_output "${HOSTING_STACK}" SiteBucketName)"
  empty_bucket "$(stack_output "${AUTH_STACK}" IntakeBucketName)"
  empty_bucket "$(stack_output "${EVAL_STACK}" DatasetBucketName)"
  empty_bucket "$(stack_output "${EVAL_STACK}" ResultsBucketName)"
fi

echo ""
echo "2. ホスティングスタックを削除します"
echo "  CloudFront は無効化してから削除されるため、15分ほどかかります。"
destroy_stack "${HOSTING_STACK}" -c "hosting=true"

echo ""
echo "3. 認証スタックとデータスタックを削除します"
destroy_stack "${AUTH_STACK}"
destroy_stack "${EVAL_STACK}"

echo ""
echo "4. Lambda@Edge の後始末"
cat <<'NOTE'
  Lambda@Edge はエッジロケーションにレプリカが残るため、CloudFront を削除した
  直後は関数を消せません。上のホスティングスタック削除がレプリカを理由に失敗した
  場合は、15分から数時間ほど待ってからもう一度このスクリプトを実行してください。
  これは AWS 側の仕様で、待つ以外の回避方法はありません。

  us-east-1 に作られるサポートスタック（名前が -support-us-east-1 で終わるもの）も
  同じタイミングで消えます。残っている場合は次で確認できます。

    aws cloudformation list-stacks --region us-east-1 \
      --stack-status-filter DELETE_FAILED CREATE_COMPLETE UPDATE_COMPLETE \
      --query "StackSummaries[?contains(StackName, 'GoldenFoundry')].StackName"
NOTE

echo ""
echo "5. 残っているものの確認"
echo "  スタック:"
aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE DELETE_FAILED ROLLBACK_COMPLETE \
  --query "StackSummaries[?contains(StackName, 'GoldenFoundry')].[StackName,StackStatus]" \
  --output table 2>/dev/null || echo "    （取得できませんでした）"

echo ""
echo "  SSM パラメータ:"
aws ssm get-parameters-by-path --path "/golden-foundry/${ENV_NAME}" --recursive \
  --query "Parameters[].Name" --output text 2>/dev/null || echo "    （なし）"

echo ""
echo "削除処理が終わりました。上の一覧に残りがなければ完了です。"
echo "評価ジョブそのものは削除できませんが、課金は発生しません。"
