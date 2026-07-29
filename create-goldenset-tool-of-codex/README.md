# Golden Foundry

AWS Summit Japan 2026「AIM311 生成AIモデルを選ぶ技術」の Evaluate ステップを参考にしたゴールデンデータセット作成用ローカルWebアプリです。

## 機能

- ユースケース、ペルソナ、評価基準から質問・期待回答を生成
- 標準、エッジ、安全性ケースの混在
- 評価基準ごとのチェック、人間による編集・承認
- ブラウザ内への自動保存
- 承認済みデータの JSONL / CSV 出力

## 起動

依存インストール不要です。

```powershell
python -m http.server 8080
```

ブラウザで http://localhost:8080 を開きます。テストは `node --test` です。

データは localStorage にだけ保存され外部へ送信されません。AI接続を追加する場合は、APIキーをブラウザへ置かずサーバー側APIを用意してください。

