import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  LambdaEdgeEventType,
  PriceClass,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
  experimental,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Code, Runtime } from "aws-cdk-lib/aws-lambda";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";

import { authParameterPath } from "./auth-parameters";

export interface GoldenHostingStackProps extends StackProps {
  /** 環境名。SSM から認証情報を引くときのキーに使う */
  readonly environmentName: string;
  /** スタック削除時にサイトバケットを残すかどうか */
  readonly removalPolicy: RemovalPolicy;
}

/** Lambda@Edge のコードへ埋め込む設定 */
interface EdgeConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly hostedUiDomain: string;
}

/** ブラウザ側が S3 を呼ぶために必要な設定。src/config.js として配信する */
interface AppConfig {
  readonly region: string;
  readonly userPoolId: string;
  readonly identityPoolId: string;
  readonly intakeBucket: string;
}

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EDGE_SOURCE = fileURLToPath(new URL("../edge/auth.mjs", import.meta.url));
const CONFIG_PLACEHOLDER = '"__GOLDEN_FOUNDRY_CONFIG__"';

/**
 * アプリを CloudFront で配信し、Lambda@Edge で Cognito 認証をかける。
 *
 * 認証情報は GoldenAuthStack が SSM に書いた値を synth 時に読み込む。
 * Lambda@Edge は環境変数を持てず、関数コードは synth の時点で確定している
 * 必要があるため、認証スタックを先にデプロイしておく前提になっている。
 */
export class GoldenHostingStack extends Stack {
  constructor(scope: Construct, id: string, props: GoldenHostingStackProps) {
    super(scope, id, props);

    const { edge, app } = this.readAuthParameters(props.environmentName);

    const siteBucket = new Bucket(this, "SiteBucket", {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: props.removalPolicy,
    });

    // Lambda@Edge は us-east-1 に置く必要がある。EdgeFunction がその
    // サポートスタックを作るため、us-east-1 にもブートストラップが要る。
    const authFunction = new experimental.EdgeFunction(this, "AuthFunction", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset(this.stageEdgeFunction(edge)),
      timeout: Duration.seconds(5),
      memorySize: 128,
      description: "Golden Foundry viewer request authentication",
    });

    const responseHeadersPolicy = this.createResponseHeadersPolicy(app);

    const distribution = new Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      priceClass: PriceClass.PRICE_CLASS_200,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy,
        edgeLambdas: [
          {
            functionVersion: authFunction.currentVersion,
            eventType: LambdaEdgeEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        // /auth/* は関数がその場でレスポンスを返す。ID トークンを含むため、
        // 万が一にもキャッシュされないよう独立したビヘイビアで無効にする。
        "/auth/*": {
          origin: S3BucketOrigin.withOriginAccessControl(siteBucket),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy,
          edgeLambdas: [
            {
              functionVersion: authFunction.currentVersion,
              eventType: LambdaEdgeEventType.VIEWER_REQUEST,
            },
          ],
        },
      },
    });

    new BucketDeployment(this, "SiteContent", {
      sources: [Source.asset(this.stageSiteContent(app))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
      // dev で消せるようにする。RETAIN の環境ではオブジェクトを残す
      retainOnDelete: props.removalPolicy === RemovalPolicy.RETAIN,
    });

    this.attachCallbackUrls(props.environmentName, distribution.distributionDomainName);

    new CfnOutput(this, "SiteUrl", {
      value: `https://${distribution.distributionDomainName}/`,
      description: "アプリのURL",
    }).overrideLogicalId("SiteUrl");
    new CfnOutput(this, "SiteBucketName", { value: siteBucket.bucketName }).overrideLogicalId(
      "SiteBucketName",
    );
    new CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
    }).overrideLogicalId("DistributionId");
  }

  /**
   * セキュリティヘッダ。ブラウザが直接呼ぶのは S3 の取り込みバケットと
   * Cognito Identity だけなので、connect-src をそこに絞る。
   * 呼び出し先を増やしたら connect-src にも足すこと
   */
  private createResponseHeadersPolicy(app: AppConfig): ResponseHeadersPolicy {
    const contentSecurityPolicy = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src 'self' https://${app.intakeBucket}.s3.${app.region}.amazonaws.com https://cognito-identity.${app.region}.amazonaws.com`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");

    return new ResponseHeadersPolicy(this, "SecurityHeaders", {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy, override: true },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });
  }

  /**
   * 認証スタックが SSM へ書いた値を synth 時に読む。
   * 未デプロイのときは CDK がダミー値を返すので、そこで止める。
   */
  private readAuthParameters(environmentName: string): { edge: EdgeConfig; app: AppConfig } {
    const read = (name: string): string => {
      const value = StringParameter.valueFromLookup(this, authParameterPath(environmentName, name));
      if (value.startsWith("dummy-value-for-")) {
        throw new Error(
          `認証情報が見つかりません（${name}）。先に GoldenFoundryAuthStack-${environmentName} をデプロイしてください。`,
        );
      }
      return value;
    };

    const userPoolId = read("user-pool-id");
    return {
      edge: {
        issuer: `https://cognito-idp.${this.region}.amazonaws.com/${userPoolId}`,
        clientId: read("client-id"),
        hostedUiDomain: read("hosted-ui-domain"),
      },
      app: {
        region: this.region,
        userPoolId,
        identityPoolId: read("identity-pool-id"),
        intakeBucket: read("intake-bucket"),
      },
    };
  }

  /**
   * Lambda@Edge は環境変数を持てないため、設定を埋め込んだコードを生成する。
   * インラインコードは 4096 文字までで収まらないので、ファイルとして staging する。
   */
  private stageEdgeFunction(config: EdgeConfig): string {
    const source = readFileSync(EDGE_SOURCE, "utf8");
    if (!source.includes(CONFIG_PLACEHOLDER)) {
      throw new Error(`${EDGE_SOURCE} に設定のプレースホルダが見つかりません。`);
    }
    const staged = mkdtempSync(join(tmpdir(), "golden-foundry-edge-"));
    writeFileSync(
      join(staged, "index.mjs"),
      source.replace(CONFIG_PLACEHOLDER, JSON.stringify(config)),
      "utf8",
    );
    return staged;
  }

  /**
   * 配信するのは index.html、src/、AWS SDK のバンドルだけ。
   * infra や scripts は含めない。ブラウザ用の設定はここで生成する。
   */
  private stageSiteContent(config: AppConfig): string {
    const staged = mkdtempSync(join(tmpdir(), "golden-foundry-site-"));
    copyFileSync(join(REPO_ROOT, "index.html"), join(staged, "index.html"));
    mkdirSync(join(staged, "src"), { recursive: true });
    cpSync(join(REPO_ROOT, "src"), join(staged, "src"), { recursive: true });
    // バンドル前のソースは配信しない。ブラウザが読むのは dist/app/ の方
    rmSync(join(staged, "src", "aws-client.js"), { force: true });
    writeFileSync(
      join(staged, "src", "config.js"),
      `export const CONFIG = ${JSON.stringify(config)};\n`,
      "utf8",
    );

    const bundle = join(REPO_ROOT, "dist", "app");
    if (!existsSync(join(bundle, "aws-client.js"))) {
      throw new Error(
        "dist/app/aws-client.js がありません。リポジトリのルートで bun run build を実行してからデプロイしてください。",
      );
    }
    mkdirSync(join(staged, "dist", "app"), { recursive: true });
    cpSync(bundle, join(staged, "dist", "app"), { recursive: true });
    return staged;
  }

  /**
   * CloudFront のドメインは関数より後に決まるため、User Pool クライアントの
   * コールバックURLをデプロイ時に更新する。UpdateUserPoolClient は渡さなかった
   * 項目を初期値に戻すので、認証スタックと同じ設定を明示的に送る。
   */
  private attachCallbackUrls(environmentName: string, domainName: string): void {
    const userPoolId = StringParameter.valueFromLookup(
      this,
      authParameterPath(environmentName, "user-pool-id"),
    );
    const clientId = StringParameter.valueFromLookup(
      this,
      authParameterPath(environmentName, "client-id"),
    );

    const parameters = {
      UserPoolId: userPoolId,
      ClientId: clientId,
      CallbackURLs: [`https://${domainName}/auth/callback`],
      LogoutURLs: [`https://${domainName}/`],
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: ["openid"],
      AllowedOAuthFlowsUserPoolClient: true,
      SupportedIdentityProviders: ["COGNITO"],
      PreventUserExistenceErrors: "ENABLED",
    };

    new AwsCustomResource(this, "CallbackUrls", {
      onCreate: {
        service: "CognitoIdentityServiceProvider",
        action: "updateUserPoolClient",
        parameters,
        physicalResourceId: PhysicalResourceId.of(`${clientId}-callback-urls`),
      },
      onUpdate: {
        service: "CognitoIdentityServiceProvider",
        action: "updateUserPoolClient",
        parameters,
        physicalResourceId: PhysicalResourceId.of(`${clientId}-callback-urls`),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${userPoolId}`],
      }),
      installLatestAwsSdk: false,
    });
  }
}
