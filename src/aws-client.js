/**
 * ブラウザから S3 の取り込みバケットを読み書きするための薄いラッパー。
 *
 * このファイルだけが AWS SDK に依存する。バンドルして dist/app/ に置き、
 * アプリ本体からは動的 import で読み込む。ローカルで動かすときは
 * バンドルが存在しないため、取り込み機能だけが無効になる。
 */
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-provider-cognito-identity";
import { CognitoIdentityClient } from "@aws-sdk/client-cognito-identity";

/**
 * Cognito の ID トークンから S3 を呼べる一時認証情報を作り、S3 クライアントを返す。
 *
 * @param {{region: string, identityPoolId: string, userPoolId: string, idToken: string}} options
 */
export function createS3Client({ region, identityPoolId, userPoolId, idToken }) {
  const providerName = `cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  return new S3Client({
    region,
    credentials: fromCognitoIdentityPool({
      client: new CognitoIdentityClient({ region }),
      identityPoolId,
      logins: { [providerName]: idToken },
    }),
  });
}

/** 取り込みバケットにある CSV の一覧。新しいものから並べる */
export async function listCsvObjects(client, bucket, prefix = "") {
  const response = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000 }),
  );
  return (response.Contents ?? [])
    .filter((object) => typeof object.Key === "string" && object.Key.toLowerCase().endsWith(".csv"))
    .map((object) => ({
      key: object.Key,
      size: object.Size ?? 0,
      lastModified: object.LastModified?.toISOString() ?? "",
    }))
    .sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}

/** CSV を文字列として読む */
export async function readCsvObject(client, bucket, key) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return response.Body.transformToString("utf-8");
}

/** 手元の CSV を取り込みバケットへ置く */
export async function putCsvObject(client, bucket, key, body) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "text/csv; charset=utf-8",
    }),
  );
}
