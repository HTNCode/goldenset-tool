#!/usr/bin/env bash
#
# 整形済みのゴールデンデータセットを S3 へ置き、Amazon Bedrock のモデル評価ジョブを作成する。
#
# 使い方:
#   EVAL_MODE=judge MODEL_IDS=anthropic.claude-3-5-haiku-20241022-v1:0 ./scripts/submit.sh
#
# 環境変数:
#   AWS_REGION           対象リージョン。AWS CLI がそのまま解釈する
#   AWS_PROFILE          対象プロファイル。同上
#   STACK_NAME           CDK スタック名 (既定: GoldenFoundryEvalStack)
#   EVAL_MODE            judge | automatic (既定: judge)
#   MODEL_IDS            評価対象モデル ID をカンマ区切りで最大 2 件 (必須)
#   JUDGE_MODEL_ID       判定モデル ID (EVAL_MODE=judge のとき必須)
#   TASK_TYPE            Summarization | Classification | QuestionAndAnswer | Generation | Custom
#                        (既定: QuestionAndAnswer)
#   METRIC_NAMES         組み込みメトリクスをカンマ区切りで指定 (既定はモードごとに切り替え)
#   DATASET_FILE         投入する JSONL (既定: dist/dataset.jsonl)
#   CRITERIA_FILE        カスタムメトリクス定義 JSON (任意)
#   DRY_RUN              1 を指定するとリクエストを表示するだけで作成しない
set -euo pipefail

ENV_NAME="${ENV_NAME:-dev}"
STACK_NAME="${STACK_NAME:-GoldenFoundryEvalStack-${ENV_NAME}}"
EVAL_MODE="${EVAL_MODE:-judge}"
TASK_TYPE="${TASK_TYPE:-QuestionAndAnswer}"
DATASET_FILE="${DATASET_FILE:-dist/dataset.jsonl}"
CRITERIA_FILE="${CRITERIA_FILE:-}"
DRY_RUN="${DRY_RUN:-0}"

# 組み込みメトリクスは評価方式ごとに使える名前が異なる。
# 自動評価:            Builtin.Accuracy / Builtin.Robustness / Builtin.Toxicity
# LLM-as-a-Judge:      Builtin.Correctness / Builtin.Completeness / Builtin.Helpfulness /
#                      Builtin.Coherence / Builtin.Relevance / Builtin.FollowingInstructions /
#                      Builtin.ProfessionalStyleAndTone / Builtin.Faithfulness /
#                      Builtin.Harmfulness / Builtin.Stereotyping / Builtin.Refusal
case "${EVAL_MODE}" in
  judge)
    DEFAULT_METRICS="Builtin.Correctness,Builtin.Completeness,Builtin.Helpfulness"
    ;;
  automatic)
    DEFAULT_METRICS="Builtin.Accuracy,Builtin.Robustness,Builtin.Toxicity"
    ;;
  *)
    echo "EVAL_MODE は judge か automatic を指定してください: ${EVAL_MODE}" >&2
    exit 1
    ;;
esac
METRIC_NAMES="${METRIC_NAMES:-${DEFAULT_METRICS}}"

if [[ -z "${MODEL_IDS:-}" ]]; then
  echo "MODEL_IDS に評価対象モデルをカンマ区切りで指定してください。" >&2
  exit 1
fi

if [[ "${EVAL_MODE}" == "judge" && -z "${JUDGE_MODEL_ID:-}" ]]; then
  echo "EVAL_MODE=judge では JUDGE_MODEL_ID が必要です。" >&2
  exit 1
fi

if [[ ! -f "${DATASET_FILE}" ]]; then
  echo "データセットが見つかりません: ${DATASET_FILE}" >&2
  echo "先に node scripts/prepare.mjs を実行してください。" >&2
  exit 1
fi

# 評価基準の不備は S3 へアップロードする前に落とす
if [[ -n "${CRITERIA_FILE}" ]]; then
  if [[ ! -f "${CRITERIA_FILE}" ]]; then
    echo "評価基準ファイルが見つかりません: ${CRITERIA_FILE}" >&2
    exit 1
  fi
  if [[ "${EVAL_MODE}" != "judge" ]]; then
    echo "カスタムメトリクスは EVAL_MODE=judge でのみ使用できます。" >&2
    exit 1
  fi
fi

for tool in aws jq; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "${tool} が必要です。" >&2
    exit 1
  fi
done

# リージョンとプロファイルは AWS_REGION / AWS_PROFILE を AWS CLI にそのまま解釈させる。
# macOS 標準の bash 3.2 では set -u のもとで空配列を展開できないため、
# --region を配列で組み立てずに環境変数へ委ねている。

# 1 ジョブで比較できるモデルは 2 件までという API 側の制限に合わせる
IFS=',' read -r -a MODEL_ID_LIST <<< "${MODEL_IDS}"
if (( ${#MODEL_ID_LIST[@]} < 1 || ${#MODEL_ID_LIST[@]} > 2 )); then
  echo "MODEL_IDS は 1〜2 件で指定してください (現在 ${#MODEL_ID_LIST[@]} 件)。" >&2
  exit 1
fi

echo "スタックの出力を取得しています: ${STACK_NAME}"
STACK_OUTPUTS="$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs' \
  --output json)"

read_output() {
  local key="$1"
  local value
  value="$(jq -r --arg key "${key}" '.[] | select(.OutputKey == $key) | .OutputValue' <<< "${STACK_OUTPUTS}")"
  if [[ -z "${value}" || "${value}" == "null" ]]; then
    echo "スタック出力 ${key} が取得できませんでした。" >&2
    exit 1
  fi
  printf '%s' "${value}"
}

DATASET_BUCKET="$(read_output DatasetBucketName)"
EVALUATION_ROLE_ARN="$(read_output EvaluationRoleArn)"
RESULTS_PREFIX_URI="$(read_output ResultsPrefixUri)"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
JOB_NAME="golden-eval-${EVAL_MODE}-${TIMESTAMP}"
DATASET_KEY="datasets/${JOB_NAME}.jsonl"
DATASET_S3_URI="s3://${DATASET_BUCKET}/${DATASET_KEY}"

echo "データセットをアップロードしています: ${DATASET_S3_URI}"
aws s3 cp "${DATASET_FILE}" "${DATASET_S3_URI}"

# 評価基準ファイルは Bedrock に直接渡すのではなく、customMetricConfig の
# instructions として展開する。ファイル自体も版を残すために S3 へ置く。
CUSTOM_METRIC_JSON="null"
if [[ -n "${CRITERIA_FILE}" ]]; then
  CRITERIA_KEY="criteria/${JOB_NAME}-$(basename "${CRITERIA_FILE}")"
  echo "評価基準をアップロードしています: s3://${DATASET_BUCKET}/${CRITERIA_KEY}"
  aws s3 cp "${CRITERIA_FILE}" "s3://${DATASET_BUCKET}/${CRITERIA_KEY}"
  CUSTOM_METRIC_JSON="$(jq \
    --arg judge "${JUDGE_MODEL_ID:-}" \
    '{
       customMetrics: [.customMetrics[] | {customMetricDefinition: .}],
       evaluatorModelConfig: { bedrockEvaluatorModels: [{ modelIdentifier: $judge }] }
     }' "${CRITERIA_FILE}")"
fi

REQUEST_FILE="dist/job-request-${JOB_NAME}.json"
mkdir -p "$(dirname "${REQUEST_FILE}")"

jq -n \
  --arg jobName "${JOB_NAME}" \
  --arg roleArn "${EVALUATION_ROLE_ARN}" \
  --arg taskType "${TASK_TYPE}" \
  --arg datasetUri "${DATASET_S3_URI}" \
  --arg outputUri "${RESULTS_PREFIX_URI}/" \
  --arg judgeModel "${JUDGE_MODEL_ID:-}" \
  --arg evalMode "${EVAL_MODE}" \
  --argjson metricNames "$(jq -Rc 'split(",")' <<< "${METRIC_NAMES}")" \
  --argjson modelIds "$(jq -Rc 'split(",")' <<< "${MODEL_IDS}")" \
  --argjson customMetricConfig "${CUSTOM_METRIC_JSON}" \
  '{
     jobName: $jobName,
     jobDescription: "Identify->Evaluate->Optimize: ゴールデンデータセットによるモデル比較",
     roleArn: $roleArn,
     applicationType: "ModelEvaluation",
     evaluationConfig: {
       automated: ({
         datasetMetricConfigs: [
           {
             taskType: $taskType,
             dataset: { name: "golden-dataset", datasetLocation: { s3Uri: $datasetUri } },
             metricNames: $metricNames
           }
         ]
       }
       + (if $evalMode == "judge"
          then { evaluatorModelConfig: { bedrockEvaluatorModels: [{ modelIdentifier: $judgeModel }] } }
          else {} end)
       + (if $customMetricConfig == null then {} else { customMetricConfig: $customMetricConfig } end))
     },
     inferenceConfig: {
       models: [$modelIds[] | { bedrockModel: { modelIdentifier: . } }]
     },
     outputDataConfig: { s3Uri: $outputUri }
   }' > "${REQUEST_FILE}"

echo ""
echo "作成するジョブの内容 (${REQUEST_FILE}):"
cat "${REQUEST_FILE}"
echo ""

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "DRY_RUN=1 のため作成をスキップしました。"
  exit 0
fi

JOB_ARN="$(aws bedrock create-evaluation-job \
  --cli-input-json "file://${REQUEST_FILE}" \
  --query 'jobArn' \
  --output text)"

echo "評価ジョブを作成しました。"
echo "  ジョブ名: ${JOB_NAME}"
echo "  ジョブ ARN: ${JOB_ARN}"
echo ""
echo "進捗の確認:"
echo "  JOB_NAME=${JOB_NAME} ./scripts/fetch-results.sh"
