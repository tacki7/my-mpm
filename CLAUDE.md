# MPM Rolling Lab — 作業メモ

薄板の冷間圧延を 2D 平面ひずみの MPM（material point method）で解き、応力状態から亀裂の発生を
判定するブラウザアプリ。参考は Banerjee, "Material Point Method Simulations of Fragmenting
Cylinders", arXiv:1201.2439（Johnson-Cook / MTS 流動応力、GTN、Johnson-Cook 損傷、
Hancock-MacKenzie、破壊した粒子の応力の扱い）。式と出典の対応は `docs/model.md`。

## 構成

| 場所 | 中身 |
|---|---|
| `src/mpm/` | ソルバー（DOM に依存しない。node からそのまま import できる） |
| `src/mpm/solver.ts` | `Sim`: P2G → 格子更新（ロール接触）→ G2P 2 段（J-bar）→ 構成則・損傷 |
| `src/mpm/material.ts` | 流動応力、J2 リターンマップ、破断ひずみ（純関数） |
| `src/mpm/params.ts` / `presets.ts` | 入力（SI 単位）と、名前付きの条件 |
| `src/app/` | ワーカー（`sim.worker.ts`）、描画（`view.ts`）、グラフ、条件パネル |
| `tools/check.mjs` | 回帰関門。`// @check` の付いたスクリプトを集めて回す |
| `tools/run.mjs` | ヘッドレスで 1 回圧延して数値を出す（`npm run sim -- --cells 6 --L 8`） |
| `tools/browser/` | 自分専用のヘッドレス Chrome（CDP）を操作する道具 |
| `docs/` | モデル（`model.md`）、検証値（`validation.md`）、デザイン（`design.md`）、条件（`presets.md`） |

## 検証の基本

1. **時間でなく信号で待つ。** ブラウザでは `__mpm.done` / `__mpm.diag.phase === 'steady'` などが真になるのを
   `cdp-cli.mjs wait` で待つ。固定 sleep は計算の速さで結果が変わる
2. **答えの分かっているケースでハーネスを先に校正する。** チェックを足したら、壊した版（例: J-bar を切る、
   摩擦を 0 にする）で FAIL することを確かめる。壊すのはコピーで（並行して同じファイルを読む計算を壊さない）
3. **推測せず中間量を出す。** 荷重がおかしいときは、J・圧力・三軸度の範囲、接触節点の数、押し込み力を
   ステップごとにダンプする。J-bar が要ることもこれで分かった（`docs/model.md`「体積ロッキング」）
4. **数値を変えたら `docs/validation.md` の実測値と測定条件を直す。** 条件（格子、板長、質量スケーリング、
   Node の版、日付）を必ず併記する
5. MPM の粒子は格子に対して動くので、同じ条件でも**格子の細かさで荷重が数十 % 変わる**。
   比べるときは格子を揃え、収束を主張するときは 2 段以上の格子で示す

## 実行

```bash
npm ci
npm run dev -- --port <dev> --strictPort      # アプリ
npm run check                                 # tsc + @check スクリプト一式（どれか FAIL で exit 1）
npm run build                                 # tsc + vite build
npm run sim -- --cells 6 --L 8 --every 2000   # 粗い圧延を 1 回（約 6 秒）
```

node は 22.18 以降（型の除去が既定で有効）。`src/` は**消去できる構文だけ**（enum・namespace・
コンストラクタ引数のプロパティ禁止。`erasableSyntaxOnly`）で書き、import は `.ts` の拡張子付き。
チェックを足すときはスクリプトの先頭付近に `// @check` を書くだけ（一覧や package.json は触らない）。
文書にチェックの件数を書かない（並行する変更が同じ行で衝突する）。

## ヘッドレス検証

`screencapture` はユーザーの画面を撮るので使わない。人が使っている Chrome にも触らない。

```bash
npm run dev -- --port <dev> --strictPort &
tools/browser/browser.sh start <cdp> <作業用ディレクトリ>/chrome-<cdp>
export CDP_PORT=<cdp>; C=tools/browser/cdp-cli.mjs
node $C nav 'http://localhost:<dev>/?autorun=1&cells=6&L=8&stopafter=12000'
node $C wait '__mpm.done' 180000
node $C eval '__mpm.diag'
node $C shot <作業用ディレクトリ>/x.png 1600 1000     # → 画像を自分で見る
node $C nav about:blank                                # 描画を止める（開いたままだと CPU を食う）
tools/browser/browser.sh stop <cdp>; tools/browser/browser.sh stop <dev>
```

画面を触ったら `CDP_PORT=<cdp> node tools/browser/smoke.mjs http://localhost:<dev>/ <作業用ディレクトリ>/smoke.png`（約 10 秒）:
読み込みエラー 0 → 粗い圧延を最後まで → 定常の荷重・出側板厚・先進率が帯の中 → 色の量のタブを全部押して再描画 → スクショ → about:blank。
1 行ずつ PASS / FAIL、どれか FAIL で exit 1。帯は標準条件・6 セル用（URL で条件を変えると外れる）。スクショは自分で見る。
画面の状態（やり直し・`stopafter`・条件パネルと URL・描画中の例外）を触ったら `CDP_PORT=<cdp> node tools/browser/ui-state.mjs http://localhost:<dev>/`（1〜2 分）。
応力状態エクスプローラを触ったら `CDP_PORT=<cdp> node tools/browser/explorer.mjs http://localhost:<dev>/ <作業用ディレクトリ>/x.png`
（実クリックで粒子を選び、表示と `Sim` の値を比べる。`Sim` はワーカーの `self.__sim` を CDP でワーカーに繋いで読む）。
ロールバイトの表示（ズーム・パン・倍率・俯瞰・主応力の向き）を触ったら `CDP_PORT=<cdp> node tools/browser/view.mjs http://localhost:<dev>/ <作業用ディレクトリ>/v`
（ホイール・ダブルクリック・ドラッグ・キーは CDP の実イベント。`v-*.png` を自分で見る）。
条件パネル（材料の定数・欠陥・入力の検証）を触ったら `CDP_PORT=<cdp> node tools/browser/panel.mjs http://localhost:<dev>/ <作業用ディレクトリ>/p.png`。
結果の書き出し（CSV・PNG・条件の URL）を触ったら `CDP_PORT=<cdp> node tools/browser/export.mjs http://localhost:<dev>/ <作業用ディレクトリ>/dl-<時刻>`
（実際にダウンロードしたファイルを読んで `__mpm.history` と比べ、条件の URL を開き直して `__mpm.params` を比べる）。

ポートは必ず渡す（既定値は無い）。`window.__mpm` は `frames` `running` `ready` `done` `diag` `cracks`
`geometry` `params` `history` `explorer`（表示中の点）`tracks`（追っている点と経路）`view`（拡大率・パン・倍率・主応力の向き）と
`run()` `restart()` `setField(id)` `screenOf(id)`（粒子の画面座標）`drawMs(n)`（今のフレームを n 回描いた 1 回の ms）、
`pressing`（亀裂の印が押されている最中）`pressAgain()`（印をもう一度押す。瞬間を撮る用）を持つ。
凡例の `data-field` が今の色の量（タブの名前は短いことがあるので、待つならこちら）。

## クエリパラメータ

`?preset=standard|front-tension|central-burst|void|high-friction&h0=1&r=25&R=100&L=16&mu=0.08&tb=0&tf=0`
`&mat=spcc|s4340|al6061&damage=johnson-cook|hancock-mackenzie|cockcroft-latham|gtn|localization|none&cells=10&ms=10000`
`&yield=von-mises|gtn&nucleation=tension|always&f0=0.005&fc=0.05`
`&field=seq|eta|s1|pres|ep|damage|sxx|syy|sxy|lagrange|porosity|loc|drucker&autorun=1&stopafter=<step>`
`&cond=<base64url JSON>`（「条件の URL をコピー」が書く。読みやすいキーに無い条件を、プリセットとの差分で。範囲外・型の合わないもの・知らないキーは無視）
— 長さは mm、張力は MPa、`r` は %。不正な値は黙って無視される（`h0`・`r`・`R` はロールが噛めない組み合わせなら 3 つとも）。
効いたかは `__mpm.params` で確かめる。`stopafter` はそのステップで 1 回止まり、「続ける」で先へ進む。

## Git 運用

`main` に直接コミットしない。ブランチ（`feat/` `fix/` `refactor/` `docs/` `perf/`）→ PR。

push 前に確認すること:
- 個人の絶対パス（`/Users/<name>/…`）、ユーザー名、メールアドレスがコード・ログ・文書に無い
- 認証情報・トークン・`.env` の類が無い
- `.claude/settings.local.json` はマシン固有なので `.gitignore` 済み

リポジトリは **private**。コミットのメールは GitHub の noreply アドレス（ローカル git config 済み）。
