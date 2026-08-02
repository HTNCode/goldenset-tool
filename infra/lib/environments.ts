import { RemovalPolicy } from "aws-cdk-lib";

export interface EnvironmentConfig {
  /**
   * デプロイ先アカウント。未指定なら CDK_DEFAULT_ACCOUNT（実行時のプロファイル）を使う。
   * 環境ごとにアカウントを分ける場合はここに ID を書く。
   */
  readonly account?: string;
  /** デプロイ先リージョン。未指定なら CDK_DEFAULT_REGION を使う */
  readonly region?: string;
  /** 人間による評価を使う環境だけ true。結果バケットにアノテーションポータル用の CORS が付く */
  readonly enableHumanEvaluation: boolean;
  /**
   * スタック削除時に S3 バケットを残すかどうか。
   * DESTROY にしてもオブジェクトが残っていると削除は失敗する（意図的に自動削除は入れていない）。
   */
  readonly bucketRemovalPolicy: RemovalPolicy;
}

/**
 * デプロイ可能な環境の一覧。環境を増やすときはここに追加する。
 * 追加した環境名はそのまま `cdk deploy -c env=<名前>` で指定でき、
 * スタック名 GoldenFoundryEvalStack-<名前> になる。
 */
export const ENVIRONMENTS = {
  dev: {
    enableHumanEvaluation: false,
    bucketRemovalPolicy: RemovalPolicy.DESTROY,
  },
  staging: {
    enableHumanEvaluation: false,
    bucketRemovalPolicy: RemovalPolicy.RETAIN,
  },
  prod: {
    enableHumanEvaluation: false,
    bucketRemovalPolicy: RemovalPolicy.RETAIN,
  },
} as const satisfies Record<string, EnvironmentConfig>;

export const DEFAULT_ENVIRONMENT_NAME = "dev";

/**
 * 環境名から設定を引く。未定義の名前は黙って既定値に落とさず失敗させる。
 * 打ち間違いで意図しない環境へデプロイするのを防ぐため。
 */
export function resolveEnvironment(name: string): EnvironmentConfig {
  const registry: Record<string, EnvironmentConfig | undefined> = ENVIRONMENTS;
  const config = registry[name];
  if (config === undefined) {
    const available = Object.keys(ENVIRONMENTS).join(", ");
    throw new Error(`環境 "${name}" は定義されていません。指定できるのは ${available} です。`);
  }
  return config;
}
