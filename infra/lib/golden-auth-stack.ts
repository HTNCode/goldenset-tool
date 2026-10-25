import { CfnOutput, RemovalPolicy, Stack } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import {
  AccountRecovery,
  CfnIdentityPool,
  CfnIdentityPoolRoleAttachment,
  Mfa,
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolDomain,
} from "aws-cdk-lib/aws-cognito";
import { Effect, FederatedPrincipal, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { BlockPublicAccess, Bucket, BucketEncryption, HttpMethods } from "aws-cdk-lib/aws-s3";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

import { authParameterPath } from "./auth-parameters";

export interface GoldenAuthStackProps extends StackProps {
  /** 環境名。Cognito ドメインの接頭辞と SSM パラメータ名に使う */
  readonly environmentName: string;
  /** ドメイン接頭辞を一意にするための文字列。アカウントIDなどを想定 */
  readonly domainSuffix: string;
  /** スタック削除時に User Pool を残すかどうか */
  readonly removalPolicy: RemovalPolicy;
}

/**
 * アプリの認証基盤。ホスティングとは別スタックにしている。
 *
 * Lambda@Edge は環境変数を持てず、関数コードは synth 時に確定している必要がある。
 * User Pool ID とクライアント ID は作成されるまで値が決まらないため、
 * このスタックを先にデプロイして SSM に書き出し、Hosting スタックが
 * synth 時にそれを読み込んで関数コードへ埋め込む。
 */
export class GoldenAuthStack extends Stack {
  constructor(scope: Construct, id: string, props: GoldenAuthStackProps) {
    super(scope, id, props);

    const userPool = new UserPool(this, "UserPool", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      // ログインできれば取り込みバケット全体を読み書きできるので、パスワードだけにしない。
      // 第2要素は認証アプリ（TOTP）だけにする。メールはパスワードの再設定に使うため、
      // 第2要素に使うと再設定の手段が無くなる。初回ログイン時に Hosted UI が登録を求める
      mfa: Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      removalPolicy: props.removalPolicy,
    });

    // Hosted UI のドメイン接頭辞はリージョン内で一意である必要がある
    const domainPrefix = `golden-foundry-${props.environmentName}-${props.domainSuffix}`.toLowerCase();
    const domain = new UserPoolDomain(this, "UserPoolDomain", {
      userPool,
      cognitoDomain: { domainPrefix },
    });

    // コールバックURLは CloudFront のドメインが決まってから Hosting スタック側で追加する。
    // ここでは認可コードフローの設定だけを済ませておく。
    const client = new UserPoolClient(this, "UserPoolClient", {
      userPool,
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID],
        callbackUrls: ["https://localhost/auth/callback"],
        logoutUrls: ["https://localhost/"],
      },
      preventUserExistenceErrors: true,
    });

    // ブラウザが S3 を直接読むための一時認証情報を発行する
    const identityPool = new CfnIdentityPool(this, "IdentityPool", {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: client.userPoolClientId,
          providerName: userPool.userPoolProviderName,
          serverSideTokenCheck: true,
        },
      ],
    });

    // 取り込み用の CSV を置くバケット。ブラウザから直接読み書きするので CORS を開ける。
    // オリジンを CloudFront のドメインに絞りたいところだが、そのドメインは
    // ホスティングスタック側で決まるため、ここでは認証済みロールでのみ触れる形にしている。
    const intakeBucket = new Bucket(this, "IntakeBucket", {
      versioned: true,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: props.removalPolicy,
      cors: [
        {
          allowedMethods: [HttpMethods.GET, HttpMethods.PUT, HttpMethods.POST, HttpMethods.HEAD],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 3000,
        },
      ],
    });

    const authenticatedRole = new Role(this, "AuthenticatedRole", {
      assumedBy: new FederatedPrincipal(
        "cognito-identity.amazonaws.com",
        {
          StringEquals: { "cognito-identity.amazonaws.com:aud": identityPool.ref },
          "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "authenticated" },
        },
        "sts:AssumeRoleWithWebIdentity",
      ),
      description: "Golden Foundry signed-in users",
    });

    authenticatedRole.addToPolicy(
      new PolicyStatement({
        sid: "AllowIntakeBucketAccess",
        effect: Effect.ALLOW,
        actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
        resources: [intakeBucket.bucketArn, intakeBucket.arnForObjects("*")],
      }),
    );

    new CfnIdentityPoolRoleAttachment(this, "IdentityPoolRoles", {
      identityPoolId: identityPool.ref,
      roles: { authenticated: authenticatedRole.roleArn },
    });

    this.putParameter("IdentityPoolIdParameter", props.environmentName, "identity-pool-id", identityPool.ref);
    this.putParameter("IntakeBucketParameter", props.environmentName, "intake-bucket", intakeBucket.bucketName);
    this.putParameter("UserPoolIdParameter", props.environmentName, "user-pool-id", userPool.userPoolId);
    this.putParameter("ClientIdParameter", props.environmentName, "client-id", client.userPoolClientId);
    this.putParameter(
      "HostedUiDomainParameter",
      props.environmentName,
      "hosted-ui-domain",
      `${domain.domainName}.auth.${this.region}.amazoncognito.com`,
    );

    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId }).overrideLogicalId("UserPoolId");
    new CfnOutput(this, "UserPoolClientId", { value: client.userPoolClientId }).overrideLogicalId(
      "UserPoolClientId",
    );
    new CfnOutput(this, "HostedUiDomain", {
      value: `${domain.domainName}.auth.${this.region}.amazoncognito.com`,
    }).overrideLogicalId("HostedUiDomain");
    new CfnOutput(this, "IdentityPoolId", { value: identityPool.ref }).overrideLogicalId(
      "IdentityPoolId",
    );
    new CfnOutput(this, "IntakeBucketName", {
      value: intakeBucket.bucketName,
      description: "取り込み用 CSV を置くバケット",
    }).overrideLogicalId("IntakeBucketName");
  }

  private putParameter(id: string, environmentName: string, name: string, value: string): void {
    new StringParameter(this, id, {
      parameterName: authParameterPath(environmentName, name),
      stringValue: value,
    });
  }
}
