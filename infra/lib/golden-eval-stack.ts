import { CfnOutput, RemovalPolicy, Stack } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { BlockPublicAccess, Bucket, BucketEncryption, HttpMethods } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

export interface GoldenEvalStackProps extends StackProps {
  /**
   * 人間による評価ジョブを使う場合は true。
   * 結果バケットにアノテーションポータル用の CORS 設定を追加する。
   */
  readonly enableHumanEvaluation: boolean;
  /** スタック削除時に S3 バケットを残すかどうか */
  readonly bucketRemovalPolicy: RemovalPolicy;
}

/** 人間評価のアノテーションポータルが結果を読み出すオリジン */
const HUMAN_ANNOTATION_ORIGIN = "https://mturk-console-template-preview-hooks.s3.amazonaws.com";

const DATASET_PREFIX = "datasets";
const CRITERIA_PREFIX = "criteria";
const RESULTS_PREFIX = "results";

/**
 * Amazon Bedrock のモデル評価ジョブを実行するための S3 バケットと IAM ロールを構築する。
 *
 * - データセットバケット: ゴールデンデータセットと評価基準ファイルを保管する
 * - 結果バケット: 評価ジョブの出力を受け取る
 * - 評価ロール: Bedrock がデータセットを読み、モデルを呼び出し、結果を書き込むために引き受ける
 */
export class GoldenEvalStack extends Stack {
  constructor(scope: Construct, id: string, props: GoldenEvalStackProps) {
    super(scope, id, props);

    const datasetBucket = new Bucket(this, "DatasetBucket", {
      versioned: true,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: props.bucketRemovalPolicy,
    });

    const resultsBucket = new Bucket(this, "ResultsBucket", {
      versioned: true,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: props.bucketRemovalPolicy,
      // CORS が必要なのは人間評価ジョブの結果バケットのみ。自動評価と
      // LLM-as-a-Judge では不要なので既定では設定しない。
      cors: props.enableHumanEvaluation
        ? [
            {
              allowedMethods: [HttpMethods.GET],
              allowedOrigins: [HUMAN_ANNOTATION_ORIGIN],
            },
          ]
        : undefined,
    });

    const evaluationRole = new Role(this, "EvaluationRole", {
      assumedBy: new ServicePrincipal("bedrock.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          // ワイルドカードのジョブ ARN はアカウント内で評価ジョブを作成させるために必要
          ArnEquals: {
            "aws:SourceArn": `arn:${this.partition}:bedrock:${this.region}:${this.account}:evaluation-job/*`,
          },
        },
      }),
      // IAM の Description は ASCII と Latin-1 しか受け付けないため英語で書く
      description: "Service role assumed by Golden Foundry model evaluation jobs",
    });

    evaluationRole.addToPolicy(
      new PolicyStatement({
        sid: "AllowAccessToCustomDatasets",
        effect: Effect.ALLOW,
        actions: ["s3:GetObject", "s3:ListBucket"],
        resources: [datasetBucket.bucketArn, datasetBucket.arnForObjects("*")],
      }),
    );

    evaluationRole.addToPolicy(
      new PolicyStatement({
        sid: "AllowAccessToOutputBucket",
        effect: Effect.ALLOW,
        actions: [
          "s3:GetObject",
          "s3:ListBucket",
          "s3:PutObject",
          "s3:GetBucketLocation",
          "s3:AbortMultipartUpload",
          "s3:ListBucketMultipartUploads",
        ],
        resources: [resultsBucket.bucketArn, resultsBucket.arnForObjects("*")],
      }),
    );

    // アクション一覧は Bedrock のサービスロール要件に合わせている。
    // sagemaker:InvokeEndpoint と marketplace 系の ARN は Bedrock 外の
    // 推論エンドポイントを評価する場合にだけ必要なため除外している。
    evaluationRole.addToPolicy(
      new PolicyStatement({
        sid: "AllowAccessToBedrockResources",
        effect: Effect.ALLOW,
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:CreateModelInvocationJob",
          "bedrock:StopModelInvocationJob",
          "bedrock:GetProvisionedModelThroughput",
          "bedrock:GetInferenceProfile",
          "bedrock:ListInferenceProfiles",
          "bedrock:GetImportedModel",
          "bedrock:GetPromptRouter",
        ],
        resources: [
          `arn:${this.partition}:bedrock:*::foundation-model/*`,
          `arn:${this.partition}:bedrock:*:${this.account}:inference-profile/*`,
          `arn:${this.partition}:bedrock:*:${this.account}:application-inference-profile/*`,
          `arn:${this.partition}:bedrock:*:${this.account}:provisioned-model/*`,
          `arn:${this.partition}:bedrock:*:${this.account}:imported-model/*`,
          `arn:${this.partition}:bedrock:*:${this.account}:default-prompt-router/*`,
        ],
      }),
    );

    this.addOutput("DatasetBucketName", datasetBucket.bucketName, "ゴールデンデータセットと評価基準を置くバケット");
    this.addOutput("ResultsBucketName", resultsBucket.bucketName, "評価ジョブの結果が出力されるバケット");
    this.addOutput("EvaluationRoleArn", evaluationRole.roleArn, "評価ジョブに渡すサービスロールの ARN");
    this.addOutput(
      "DatasetPrefixUri",
      `s3://${datasetBucket.bucketName}/${DATASET_PREFIX}`,
      "データセットのアップロード先",
    );
    this.addOutput(
      "CriteriaPrefixUri",
      `s3://${datasetBucket.bucketName}/${CRITERIA_PREFIX}`,
      "評価基準ファイルのアップロード先",
    );
    this.addOutput(
      "ResultsPrefixUri",
      `s3://${resultsBucket.bucketName}/${RESULTS_PREFIX}`,
      "評価ジョブの outputDataConfig に渡す S3 URI",
    );
  }

  /**
   * 論理 ID を固定した出力を追加する。
   * スクリプト側が describe-stacks の OutputKey で値を引くため、CDK の自動採番に任せない。
   */
  private addOutput(key: string, value: string, description: string): void {
    const output = new CfnOutput(this, key, { value, description });
    output.overrideLogicalId(key);
  }
}
