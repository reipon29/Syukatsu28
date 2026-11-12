# 就活管理 PWA

就職活動の企業・選考ステータス・予定（ES締切や面接）を管理する PWA です。
ビルド不要の HTML / CSS / JavaScript だけで動き、GitHub Pages でそのまま公開できます。

## 機能
- 企業の登録（業界・ステータス・志望度・マイページURL・ログインID・メモ）
- ステータス別の絞り込み・検索・並び替え
- 企業ごとの予定・締切管理、全社横断の予定一覧（今日 / ◯日後 表示）
- Google カレンダーへの予定追加リンク
- JSON でのバックアップ書き出し / 読み込み
- オフライン動作・ホーム画面への追加
- ダークモード対応

## データについて
データはブラウザの localStorage（端末内）にのみ保存され、サーバーには送信されません。
端末を変えるときは「設定 → バックアップを書き出す」で移行してください。

## ローカルで動かす
```sh
python3 -m http.server 8000
# http://localhost:8000 を開く
```

## GitHub Pages で公開
1. GitHub にリポジトリを作成して push
2. Settings → Pages → Source: `Deploy from a branch`、Branch: `main` / `/ (root)` を選択
3. 数分後 `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開されます

## 更新時の注意
ファイルを変更したら `sw.js` の `CACHE_VERSION` を上げてください。
