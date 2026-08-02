import { App, Tags } from "aws-cdk-lib";
import { GoldenAuthStack } from "../lib/golden-auth-stack";
import { GoldenEvalStack } from "../lib/golden-eval-stack";
import { GoldenHostingStack } from "../lib/golden-hosting-stack";
import { DEFAULT_ENVIRONMENT_NAME, resolveEnvironment } from "../lib/environments";

const CONTEXT_ENVIRONMENT = "env";
const CONTEXT_HOSTING = "hosting";

/**
 * `-c env=<名前>` で渡された値を環境名として読む。
 * 未指定なら既定環境、文字列以外なら誤用として失敗させる。
 */
function readEnvironmentName(app: App): string {
  const value: unknown = app.node.tryGetContext(CONTEXT_ENVIRONMENT);
  if (value === undefined || value === null || value === "") {
    return DEFAULT_ENVIRONMENT_NAME;
  }
  if (typeof value !== "string") {
    throw new Error(`-c ${CONTEXT_ENVIRONMENT} には環境名を文字列で指定してください。`);
  }
  return value;
}

function readBooleanContext(app: App, key: string): boolean {
  const value: unknown = app.node.tryGetContext(key);
  return value === true || value === "true";
}

const app = new App();
const environmentName = readEnvironmentName(app);
const environment = resolveEnvironment(environmentName);

const account = environment.account ?? process.env.CDK_DEFAULT_ACCOUNT;
const region = environment.region ?? process.env.CDK_DEFAULT_REGION;
const env = { account, region };

new GoldenEvalStack(app, `GoldenFoundryEvalStack-${environmentName}`, {
  env,
  description: `Golden Foundry (${environmentName}): Amazon Bedrock モデル評価ジョブ用の S3 バケットとサービスロール`,
  enableHumanEvaluation: environment.enableHumanEvaluation,
  bucketRemovalPolicy: environment.bucketRemovalPolicy,
});

new GoldenAuthStack(app, `GoldenFoundryAuthStack-${environmentName}`, {
  env,
  description: `Golden Foundry (${environmentName}): アプリの Cognito 認証基盤`,
  environmentName,
  domainSuffix: account ?? "unknown",
  removalPolicy: environment.bucketRemovalPolicy,
});

// ホスティングスタックは認証スタックが書いた SSM パラメータを synth 時に読む。
// 認証スタックの初回デプロイ前は読めないため、明示的に有効化したときだけ組み立てる。
if (readBooleanContext(app, CONTEXT_HOSTING)) {
  if (account === undefined || region === undefined) {
    throw new Error(
      "ホスティングスタックにはアカウントとリージョンが必要です。AWS_PROFILE と AWS_REGION を設定してから実行してください。",
    );
  }
  new GoldenHostingStack(app, `GoldenFoundryHostingStack-${environmentName}`, {
    env,
    description: `Golden Foundry (${environmentName}): CloudFront によるアプリ配信`,
    environmentName,
    removalPolicy: environment.bucketRemovalPolicy,
  });
}

Tags.of(app).add("Project", "GoldenFoundry");
Tags.of(app).add("Environment", environmentName);
