/**
 * 認証スタックが書き出し、ホスティングスタックが synth 時に読む SSM パラメータのパス。
 * 両方のスタックから参照するため、どちらにも依存しないファイルに置いている。
 */
export function authParameterPath(environmentName: string, name: string): string {
  return `/golden-foundry/${environmentName}/auth/${name}`;
}
