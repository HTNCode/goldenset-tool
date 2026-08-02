# Golden Foundry

AWS Summit Japan 2026「AIM311 生成AIモデルを選ぶ技術 - モデル選択のフレームワーク -」の Identify → Evaluate → Optimize のうち、Evaluate ステップを実際に回すための一式を作ってみたものです。

ブラウザ上でゴールデンデータセット（質問と期待回答のペア）を作り、人間がレビューして承認し、Amazon Bedrock のモデル評価ジョブに投入してモデルを比較するところまでを扱います。

全体像は [docs/architecture.drawio](docs/architecture.drawio) にまとめてあります（アーキテクチャ、モデル選択サイクル、ホスティング構成の3ページ構成）。VS Code の Draw.io Integration 拡張、または [app.diagrams.net](https://app.diagrams.net) で開けます。

LLMによるプロトタイプとして作成してみただけのものであるため、実際の利用は自己責任でお願いいたします。

## リポジトリ構成

| パス                                    | 役割                                                     |
| --------------------------------------- | -------------------------------------------------------- |
| [index.html](index.html) / [src/](src/) | ゴールデンデータセット作成用のローカルWebアプリ          |
| [tests/](tests/)                        | 生成ロジックのテスト                                     |
| [scripts/](scripts/)                    | データセットの検証・整形、評価ジョブの投入、結果の取得   |
| [criteria/](criteria/)                  | 評価基準ファイル。人間が管理する唯一の物差し             |
| [infra/](infra/)                        | AWS CDK。評価基盤、Cognito 認証、CloudFront 配信の3スタック |
| [docs/](docs/)                          | アーキテクチャ図                                         |

## 必要なもの

- ブラウザと Python 3（ローカルでアプリを配信する場合のみ）
- Node.js 20 以上（テストとデータセット検証）
- AWS CLI v2 と jq（評価ジョブの投入と削除スクリプト）
- bun（CDK の依存管理とアプリのバンドル。pnpm や npm でも構いません）
- Bedrock のモデルアクセスが有効なAWSアカウント

## Step 1: アプリを起動する

依存インストールは不要です。リポジトリのルートで実行します。

```bash
python -m http.server 8080
```

ブラウザで http://localhost:8080 を開きます。停止は Ctrl+C です。

`index.html` は ES モジュールを読み込むため、ファイルを直接ダブルクリックして `file://` で開くと動きません。必ず HTTP サーバー経由で開いてください。なお、このコマンドはリポジトリのルートを丸ごと配信するので、`infra/` や `criteria/` も localhost から見える状態になります。ローカル作業用と割り切ってください。

テストは次のとおりです。

```bash
node --test
```

## Step 2: ゴールデンデータセットを作る

1. 左の「生成条件」にユースケース（10文字以上）、対象ペルソナ、評価基準（1行1基準）を入力し、含めるケース（標準 / エッジ / 安全性）を選んで「候補データを生成」を押します。
2. 右の「レビューキュー」に候補が並びます。質問と期待される回答はテキストエリアを直接書き換えられ、フォーカスを外した時点で localStorage に保存されます。
3. 内容を確認したら「承認する」を押します。除外したいものは「除外」です。
4. 右上の「エクスポート」から JSONL を保存します。書き出されるのは承認済みのものだけです。

候補の生成は固定テンプレートによるもので、AIは呼んでいません。カテゴリごとに3通り、3カテゴリ全選択でも9通りしかないため、20件を選ぶと質問が繰り返されます。期待される回答も定型文です。

つまりステップ3のレビューが本体です。ここで期待回答を実際の正解に書き換えないと、評価スコアは意味を持ちません。次のステップの検証はそれを機械的に止めるようになっています。

## Step 3: データセットを検証して整形する

```bash
node scripts/prepare.mjs --input golden-dataset.jsonl --output dist/dataset.jsonl
```

次を検査し、1つでも該当すれば終了コード1で止まります。

- 各行が有効なJSONオブジェクトであること
- `prompt` が空でない文字列であること
- レコード数が1件以上1000件以下であること（サービスクォータで固定。引き上げ申請はできません）
- 期待回答が使い回されていないこと

1000件はサービスクォータで固定されており、引き上げ申請もできません。これを超えるデータセットを扱う場合は分割して複数のジョブを走らせてください。評価ジョブ数の上限は5000、同時実行は20なので分割自体は現実的です。カテゴリごとに分ければカテゴリ別のスコアも取りやすくなります。

最後の項目が、アプリの定型文をそのまま投入することへの歯止めです。Correctness や Completeness は期待回答を正解として突き合わせるため、全件同じ文言では正解を測っていない数字が出ます。重複を承知で通す場合は `--allow-duplicate-answers` を付けてください。

Bedrock が解釈しないキー（アプリが付ける `metadata` など）は警告を出したうえで除去します。

## Step 4: AWS 環境を作る

```bash
cd infra
bun install
```

デプロイ先のアカウントとリージョンは環境変数で決まります。CDK は synth 時にリージョンを埋め込むため、デプロイの前に設定してください。

```bash
export AWS_PROFILE=your-profile
export AWS_REGION=ap-northeast-1
```

### 環境を選ぶ

`-c env=<環境名>` で切り替えます。省略時は `dev` です。環境ごとに別スタックになるので、同じアカウントに並べて置けます。

| 環境名    | スタック名                       | バケットの削除ポリシー |
| --------- | -------------------------------- | ---------------------- |
| `dev`     | `GoldenFoundryEvalStack-dev`     | DESTROY                |
| `staging` | `GoldenFoundryEvalStack-staging` | RETAIN                 |
| `prod`    | `GoldenFoundryEvalStack-prod`    | RETAIN                 |

定義は [infra/lib/environments.ts](infra/lib/environments.ts) にあります。環境を増やすときはここに追加してください。未定義の名前を渡した場合は、既定値に落とさずエラーで停止します。打ち間違いで意図しない環境にデプロイしないためです。

環境ごとにアカウントを分ける場合は `account` にアカウントIDを書きます。未指定なら実行時のプロファイルのアカウントが使われます。

`dev` の DESTROY はスタック削除時にバケットも消す設定ですが、オブジェクトが残っていると削除は失敗します。評価データを黙って消さないよう、自動削除は入れていません。

### デプロイ

型チェックとテンプレートの確認をしてから進めます。

```bash
bun run typecheck
bunx cdk synth -c env=dev
```

そのアカウントとリージョンで CDK を初めて使う場合はブートストラップが必要です。環境ごとではなく、アカウントとリージョンの組み合わせごとに1回です。

```bash
bunx cdk bootstrap
```

デプロイします。IAM ロールを作るため承認を求められます。

```bash
bunx cdk deploy -c env=dev
```

すべてのリソースに `Project=GoldenFoundry` と `Environment=<環境名>` のタグが付きます。

作られるリソースは次の3つです。

- データセットバケット: `datasets/` にゴールデンデータセット、`criteria/` に評価基準ファイルを置きます
- 結果バケット: 評価ジョブの出力先です
- 評価ロール: `bedrock.amazonaws.com` が引き受けます。信頼ポリシーは `aws:SourceAccount` と `aws:SourceArn` でこのアカウントの評価ジョブに限定しています

両バケットとも versioning、パブリックアクセス全ブロック、SSL必須で作られます。削除ポリシーは上の表のとおり環境ごとに異なります。

人間による評価を使う場合は、結果バケットにアノテーションポータル用の CORS 設定が必要です。自動評価と LLM-as-a-Judge では不要なため、既定ではどの環境も無効にしています。必要な環境の `enableHumanEvaluation` を `true` にしてデプロイし直してください。

CORS が要るのは Bedrock コンソールから作成した人間評価ジョブなので、ジョブ自体もコンソールから作る前提になります。[scripts/submit.sh](scripts/submit.sh) が扱うのは自動評価と LLM-as-a-Judge の2種類です。

## Step 5: アプリをホストする

ローカルで動かすだけなら Step 1 のままで構いません。ブラウザからアクセスできる形にして Cognito 認証をかける場合はこの手順です。

CloudFront が S3 のアプリを配信し、すべてのリクエストを Lambda@Edge が受けて Cognito の ID トークンを検証します。ログインしていないリクエストは Hosted UI に送られるため、`index.html` を含めて未認証では取得できません。ログイン後は Identity Pool が発行する一時認証情報で、ブラウザから取り込みバケットの CSV を直接読み書きします。

### 認証スタックを先にデプロイする

デプロイは2回に分かれます。Lambda@Edge は環境変数を持てず、関数コードは合成の時点で確定している必要がありますが、User Pool ID とクライアント ID は作成されるまで決まりません。そのため認証スタックを先にデプロイして SSM に書き出し、配信スタックが合成時にそれを読む形にしています。

```bash
cd infra
bunx cdk deploy -c env=dev GoldenFoundryAuthStack-dev
```

### 利用者を登録する

自己サインアップは無効にしてあります。使う人を管理者が登録してください。

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <出力された UserPoolId> \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true
```

### アプリをビルドする

ブラウザから S3 を呼ぶ部分だけが AWS SDK に依存しています。リポジトリのルートでバンドルしてください。

```bash
cd ..
bun install
bun run build
```

### 配信スタックをデプロイする

Lambda@Edge の関数は us-east-1 に作られるため、そちらにも1度だけブートストラップが必要です。

```bash
cd infra
bunx cdk bootstrap aws://<アカウントID>/us-east-1
bunx cdk deploy -c env=dev -c hosting=true GoldenFoundryHostingStack-dev
```

出力された `SiteUrl` を開くとログイン画面に飛びます。`-c hosting=true` を付けたときだけ配信スタックが組み立てられます。認証スタックが未デプロイの状態では SSM から値を読めないため、明示的に有効化する形にしています。

### 既存データを CSV で取り込む

すでに質問と回答のデータがある場合は、CSV を取り込みバケットに置くとレビューキューに読み込めます。アプリ右上の「S3 から取り込む」で一覧を開き、選ぶと候補として追加されます。同じ画面から手元の CSV をアップロードすることもできます。

列は次の名前で認識します。大文字小文字とスペースは無視されます。

| 内容 | 認識するヘッダー名 |
| --- | --- |
| 質問 | `prompt` / `question` / `質問` |
| 期待回答 | `referenceResponse` / `expectedAnswer` / `answer` / `期待回答` / `期待される回答` |
| カテゴリ | `category` / `カテゴリ` / `カテゴリー` |

必須なのは質問の列だけです。カテゴリが `standard` / `edge` / `safety` 以外なら `standard` として扱います。取り込んだ候補は承認前の状態で入るので、生成した候補と同じようにレビューして承認してください。

なお [scripts/submit.sh](scripts/submit.sh) と [scripts/fetch-results.sh](scripts/fetch-results.sh) は手元のターミナルから実行するツールのままです。ブラウザからは AWS CLI を呼べないため、データセットの作成と承認はホストしたアプリで、評価ジョブの投入は手元から、という分担になります。

## Step 6: 評価ジョブを投入する

以降はリポジトリのルートで実行します。

```bash
ENV_NAME=dev \
EVAL_MODE=judge \
MODEL_IDS=global.anthropic.claude-sonnet-5,global.anthropic.claude-opus-5 \
JUDGE_MODEL_ID=global.anthropic.claude-opus-5 \
CRITERIA_FILE=criteria/support-quality.json \
./scripts/submit.sh
```

データセットを S3 にアップロードし、リクエスト内容を `dist/job-request-<ジョブ名>.json` に書き出して表示してから作成します。内容だけ確認したい場合は `DRY_RUN=1` を付けてください。

### モデルIDの指定

モデルIDには推論プロファイルのプレフィックスを含めます。ap-northeast-1（東京）は Claude Opus 5 も Sonnet 5 も In-Region 呼び出しとアジア地域の geo プロファイルに対応しておらず、グローバル推論プロファイルだけが使えます。

| モデル          | 東京から使えるID                   |
| --------------- | ---------------------------------- |
| Claude Opus 5   | `global.anthropic.claude-opus-5`   |
| Claude Sonnet 5 | `global.anthropic.claude-sonnet-5` |

米国リージョンから実行する場合は `us.anthropic.claude-opus-5` のような geo プロファイルも使えます。プレフィックスなしの `anthropic.claude-opus-5` が使えるのは、そのモデルが In-Region 対応しているリージョンだけです。使いたいモデルの対応状況は Bedrock のモデルカードで確認してください。

評価対象モデルの件数には注意が必要です。API の定義では1ジョブあたり2件まで指定できますが、サービスクォータ「Number of models in automated model evaluation job」は1件です。自動評価では1件にしてください。LLM-as-a-Judge で2件を並べられるかは実際にジョブを作って確かめる必要があり、通らない場合はモデルごとにジョブを分けて結果を突き合わせることになります。

`submit.sh` の主な環境変数は次のとおりです。シェルを開き直した場合は Step 4 で設定した `AWS_PROFILE` と `AWS_REGION` を再度設定してください。

| 変数             | 既定値                               | 説明                                                                               |
| ---------------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| `AWS_REGION`     | なし                                 | 対象リージョン。AWS CLI がそのまま解釈します                                       |
| `AWS_PROFILE`    | なし                                 | 対象プロファイル。同上                                                             |
| `EVAL_MODE`      | `judge`                              | `judge`（LLM-as-a-Judge）または `automatic`（自動評価）                            |
| `MODEL_IDS`      | なし（必須）                         | 評価対象モデル。カンマ区切り。下の注意を参照                                       |
| `JUDGE_MODEL_ID` | なし                                 | 判定モデル。`judge` のとき必須で、指定できるのは1件                                |
| `TASK_TYPE`      | `QuestionAndAnswer`                  | `Summarization` / `Classification` / `QuestionAndAnswer` / `Generation` / `Custom` |
| `METRIC_NAMES`   | モードごとに切替                     | 組み込みメトリクスをカンマ区切りで指定                                             |
| `CRITERIA_FILE`  | なし                                 | カスタムメトリクス定義。`judge` のときのみ使用可                                   |
| `ENV_NAME`       | `dev`                                | 対象環境。スタック名の導出に使う                                                   |
| `STACK_NAME`     | `GoldenFoundryEvalStack-${ENV_NAME}` | スタック名を直接指定したい場合                                                     |
| `DRY_RUN`        | `0`                                  | `1` でジョブを作成せずリクエストの表示のみ                                         |

### 組み込みメトリクスの意味

組み込みメトリクスは評価方式ごとに使える名前が異なります。混ぜるとジョブ作成が失敗します。

#### 自動評価（`EVAL_MODE=automatic`）

判定モデルを使わず、アルゴリズムで機械的にスコアを出します。3つとも指定できます。

| メトリクス           | 何を測るか                                 | 既定の `TASK_TYPE=QuestionAndAnswer` での計算 | 良い方向     |
| -------------------- | ------------------------------------------ | --------------------------------------------- | ------------ |
| `Builtin.Accuracy`   | 回答が正解とどれだけ一致するか             | F1スコア（適合率と再現率から算出、0〜1）      | 高いほど良い |
| `Builtin.Robustness` | 入力の小さな揺らぎで出力がどれだけ変わるか | 摂動前後のF1の変化率 (ΔF1 / F1) × 100         | 低いほど良い |
| `Builtin.Toxicity`   | 有害な表現をどれだけ含むか                 | detoxify アルゴリズムによる有害度             | 低いほど良い |

Robustness と Toxicity は値が小さいほど良い点に注意してください。Accuracy だけが高いほど良い指標です。

Robustness でいう「揺らぎ」は次の5種類です。1件のプロンプトにつき約5回の摂動を加え、それぞれ推論し直してスコアの変化を測ります。全文を小文字化する、キーボードの打ち間違いを混ぜる、数字を単語に置き換える、ランダムに大文字化する、空白をランダムに足したり削ったりする。

Accuracy の計算方法はタスクタイプで変わります。

| `TASK_TYPE`         | Accuracy の計算                                                       |
| ------------------- | --------------------------------------------------------------------- |
| `Generation`        | Real World Knowledge スコア。実世界の事実をどれだけ正しく持っているか |
| `Summarization`     | BERTScore。BERT の文脈埋め込みで候補文と参照文をコサイン類似度で照合  |
| `QuestionAndAnswer` | F1スコア                                                              |
| `Classification`    | 正解ラベルとの一致率                                                  |

#### LLM-as-a-Judge（`EVAL_MODE=judge`）

判定モデルが回答を読んで採点します。1つのデータセットに指定できるメトリクスは3つまでです（サービスクォータ「Number of metrics per dataset」）。

| メトリクス                         | 判定モデルが見るもの                                                   | 期待回答の利用 |
| ---------------------------------- | ---------------------------------------------------------------------- | -------------- |
| `Builtin.Correctness`              | 回答が正しいか                                                         | 使う           |
| `Builtin.Completeness`             | プロンプト内のすべての問いに答えているか                               | 使う           |
| `Builtin.Faithfulness`             | プロンプトに無い情報を持ち出していないか（提示された文脈への忠実さ）   | 使わない       |
| `Builtin.Helpfulness`              | 役に立つか。指示への追従、筋の通り方、暗黙のニーズの先読みを含めて判断 | 使わない       |
| `Builtin.Coherence`                | 論理の飛躍、矛盾、食い違いがないか                                     | 使わない       |
| `Builtin.Relevance`                | プロンプトに対して的を射ているか                                       | 使わない       |
| `Builtin.FollowingInstructions`    | プロンプト中の具体的な指示をどれだけ守っているか                       | 使わない       |
| `Builtin.ProfessionalStyleAndTone` | 文体、書式、トーンがビジネス文脈にふさわしいか                         | 使わない       |
| `Builtin.Harmfulness`              | 有害な内容を含むか                                                     | 使わない       |
| `Builtin.Stereotyping`             | ステレオタイプを含むか（肯定的なものも対象）                           | 使わない       |
| `Builtin.Refusal`                  | 回答を拒否した、または理由をつけて要求を退けたか                       | 使わない       |

期待回答（`referenceResponse`）を採点に使うのは Correctness と Completeness の2つだけです。この2つが Step 3 の重複チェックが必要な理由で、期待回答が全件同じままだとこの2指標が意味を失います。逆に言えば、期待回答なしでも残りの9指標は機能します。

下の3つ（Harmfulness / Stereotyping / Refusal）は責任あるAIの観点の指標で、judge モードでのみ使えます。

## Step 7: 結果を取得する

```bash
JOB_NAME=golden-eval-judge-20260802-120000 ./scripts/fetch-results.sh
```

ステータスを表示し、完了していれば結果を `dist/results` に同期します。まだ実行中なら何もせず終了するので、間を置いて実行してください。こちらも `AWS_REGION` と `AWS_PROFILE` を参照します。保存先を変えたい場合は `OUTPUT_DIR` を指定してください。

スコアが揃ったら、品質メトリクスと運用メトリクス（コスト、レイテンシ）の両面で比較して採用モデルを決めます。改善の余地があれば Optimize（ファインチューニング、プロンプトキャッシング、推論ティアの調整）に進み、また Evaluate に戻ります。

## 作ったものを消す

試したあとに環境ごとまとめて削除できます。

```bash
ENV_NAME=dev ./scripts/teardown.sh
```

バケットの中身を空にしてからスタックを削除します。バージョニングを有効にしているため `aws s3 rm --recursive` では削除マーカーとバージョンが残ってバケットを消せません。スクリプトは `list-object-versions` で両方を集めて削除します。

Lambda@Edge はエッジロケーションにレプリカが残るため、CloudFront を削除した直後は関数を消せません。配信スタックの削除がレプリカを理由に失敗した場合は、15分から数時間ほど待ってからもう一度実行してください。AWS 側の仕様で、待つ以外の回避方法はありません。この待ち時間が Lambda@Edge を選んだことの主なコストです。

`KEEP_DATA=1` を付けるとバケットの中身を残します。その場合スタックの削除は失敗します。`YES=1` で確認を省略できます。

最後に残っているスタックと SSM パラメータを一覧表示するので、消し残しがないか確認できます。

## 評価基準ファイル

[criteria/support-quality.json](criteria/support-quality.json) が評価基準ファイルです。判定モデルへの採点指示（カスタムメトリクス）を定義しており、人間が管理するのはこのファイルだけで済むようにしています。

```json
{
  "customMetrics": [
    {
      "name": "support_answer_quality",
      "instructions": "役割 → タスク → 評価観点 → 採点基準 → 入力変数 の順で書く",
      "ratingScale": [{ "definition": "要改善", "value": { "floatValue": 0 } }]
    }
  ]
}
```

書くときの制約は次のとおりです。

- `name` は63文字以内、使えるのは英数字とハイフン、アンダースコア、ピリオドのみ
- `instructions` は5000文字以内。入力変数は必ず最後に置く（後ろに指示を続けると正しく評価されません）
- 使える入力変数は `{{prompt}}`（質問）、`{{prediction}}`（モデルの回答）、`{{ground_truth}}`（期待回答）の3つ
- `ratingScale` は10段階まで。`definition` は100文字以内で、プロンプト中の採点基準と同じ言葉にする
- カスタムメトリクスは1ジョブあたり10件まで

`submit.sh` はこのファイルを S3 の `criteria/` にもアップロードするので、どの基準で採点したジョブなのかを後から追えます。

## 注意点

- 評価対象モデルと判定モデルは、そのリージョンで事前にモデルアクセスを有効化しておく必要があります。有効化されていないモデルを指定するとジョブが失敗します。
- 評価ジョブはモデル推論と判定モデルの呼び出しの両方で課金されます。件数とモデルを絞って試してから本番のデータセットに広げてください。
- LLM-as-a-Judge は判定モデル自身のバイアス（特定の文体を好むなど）が結果に乗ります。人間評価やプログラマティック評価と併用して確かめるのが安全です。
- アプリのデータは localStorage にのみ保存され、承認してエクスポートするまで外部には出ません。AI接続を追加する場合は、APIキーをブラウザに置かずサーバー側APIを用意してください。
