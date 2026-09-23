# MPM Rolling Lab — 作業メモ

薄板の冷間圧延を 2D 平面ひずみの MPM（material point method）で解き、応力状態から亀裂の発生を
判定するブラウザアプリ。参考は Banerjee, "Material Point Method Simulations of Fragmenting
Cylinders", arXiv:1201.2439（Johnson-Cook / MTS 流動応力、GTN、Johnson-Cook 損傷、
Hancock-MacKenzie、破壊した粒子の応力の扱い）。式と出典の対応は `docs/model.md`。

## 構成

| 場所 | 中身 |
|---|---|
| `src/mpm/` | ソルバー（DOM に依存しない。node からそのまま import できる） |
| `src/mpm/solver.ts` | `Sim`: P2G → 格子更新（ロール接触）→ G2P 2 段（体積の平均化）→ 構成則・損傷 |
| `src/mpm/material.ts` | 流動応力、J2 リターンマップ、破断ひずみ（純関数） |
| `src/mpm/params.ts` / `presets.ts` | 入力（SI 単位）と、名前付きの条件 |
| `src/mpm/tandem.ts` | タンデム（`TandemSim`: スタンドを 1 つずつ解き、材料の状態を次のスタンドの新しい格子へ写す）。`node tools/tandem.mjs --stands 3 [--handoff steady]`（`run.mjs` と同じ引数） |
| `src/mpm/planview/` | 平面図モデル（x 圧延方向・z 板幅方向、板厚は粒子の状態）。耳割れ用。`node tools/planview.mjs --W 20`。定常の読み方は `steady.ts`（ツールと画面の平面図で共通） |
| `src/mpm/solid/` | 3 次元モデル（`Sim3`: x・y・z を解く 1/4 モデル、幅広がり・板幅方向の荷重分布）。画面の「3 次元」のタブ（`src/app/solidMode.ts`・`solidView.ts`・`solid.worker.ts`。止まったあとの巻き戻し再生は `tape.ts`、その動画ファイルは `solidVideo.ts`（WebCodecs）と `mux.ts`（MP4・WebM を自前で書く。`tools/checks/mux.mjs` が ffmpeg の本物のフレームで検証））。タンデム・定常になるまでの板長は `tandem3.ts`（`Tandem3`）、ロール偏平・圧下率一定は `Sim3.adjustRolls`。`node tools/solid.mjs --W 8 --L 12 --cells 4 [--plane-strain] [--length steady] [--stands 3 --handoff steady] [--flatten hitchcock --control reduction] [--bend <バレル mm> [--span <mm>]] [--crown <µm>]`（4 セルで約 2.5 分）。ロールの撓みは `rollBend.ts`（梁）+ `Sim3.updateBend`。入側の板クラウン・出側のクラウンと平坦度は `Sim3.ySize`・`exitMeasure`・`steady.ts`。GPU は `solid/gpu/`（`kernels.ts` WGSL・`stepper.ts`）+ `Sim3.advanceBatch`、比較の頁は `tools/gpu/check.html`。CPU の複数スレッドは `team.ts`（`Team`: 調整役 + 貼り付けた `Sim3` の段ごとの関門）+ `grid3.ts`（格子の写し・同期の塊・部分和の配置）、入口は `src/app/solid.helper.worker.ts`（ブラウザ）と `tools/lib/solid-helper.mjs`・`solid-team.mjs`（node）。`node tools/solid.mjs --threads 4`。`SharedArrayBuffer` のため `vite.config.ts` が COOP / COEP を付ける |
| `src/app/` | ワーカー（`sim.worker.ts`）、描画（`view.ts`）、グラフ、条件パネル |
| `tools/check.mjs` | 回帰関門。`// @check` の付いたスクリプトを集めて回す |
| `tools/run.mjs` | ヘッドレスで 1 回圧延して数値を出す（`npm run sim -- --cells 6 --L 8`。`--half` = 板厚方向の対称モデル、上半分だけ） |
| `tools/browser/` | 自分専用のヘッドレス Chrome（CDP）を操作する道具 |
| `docs/` | モデル（`model.md`）、検証値（`validation.md`）、デザイン（`design.md`）、条件（`presets.md`） |

## 検証の基本

1. **時間でなく信号で待つ。** ブラウザでは `__mpm.done` / `__mpm.diag.phase === 'steady'` などが真になるのを
   `cdp-cli.mjs wait` で待つ。固定 sleep は計算の速さで結果が変わる
2. **答えの分かっているケースでハーネスを先に校正する。** チェックを足したら、壊した版（例: J-bar を切る、
   摩擦を 0 にする）で FAIL することを確かめる。壊すのはコピーで（並行して同じファイルを読む計算を壊さない）
3. **推測せず中間量を出す。** 荷重がおかしいときは、J・圧力・三軸度の範囲、接触節点の数、押し込み力を
   ステップごとにダンプする。体積ロッキングも、以前の J-bar の圧力の拡散もこれで分かった（`docs/model.md`「体積の平均化」）
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

CI（`.github/workflows/check.yml`）が push のたびに `npm ci` → `npm run check` → `npm run build` を回す（ubuntu・Node 24、
1 回約 9.5 分: 関門のスクリプトの合計 552 s のうち roll-flattening.mjs 93 s・solid3.mjs 85 s、2026-09-21。ランナーの速さで 1.5 倍ほど揺れる（同じ日の前の回は合計 339 s・roll-flattening 63 s）。2026-09-22 に solid3-tandem.mjs（手元で 69 s）と solid3-threads.mjs（手元で 150 s。2 コアの CI では 180 s の既定の上限を超えるので `// @check 600s`）を足した。上限 30 分）。
PR にはその枝の push の結果が付く。

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
板厚方向の対称モデル（`rolling.halfThickness`、`src/mpm/solver.ts` のゴースト行・`view.ts` の鏡像・条件パネルの「板厚方向」）を触ったら `node tools/checks/half-thickness.mjs`（`@check`、約 25 s: 全厚と 1e-9 で一致・速い・中心割れの面が対称面の上で開く・タンデム 2 スタンド・既定の荷重をビットで留める）と
`CDP_PORT=<cdp> node tools/browser/half.mjs http://localhost:<dev>/ <作業用ディレクトリ>/dl-half <作業用ディレクトリ>/half.png`（約 40 s。選んで反映 → 最後まで回して node の `TandemSim` と 1e-5 → 継ぎ目の上下の描画 → 鏡像の実クリック → URL `sym=1` → CSV → URL を開き直す。`half.png` を自分で見る）。
結果の書き出し（CSV・PNG・条件の URL）を触ったら `CDP_PORT=<cdp> node tools/browser/export.mjs http://localhost:<dev>/ <作業用ディレクトリ>/dl-<時刻>`
（実際にダウンロードしたファイルを読んで `__mpm.history` と比べ、条件の URL を開き直して `__mpm.params` を比べる）。
平面図の画面（切り替え・平面図のワーカー・描画・結果・URL）を触ったら `CDP_PORT=<cdp> node tools/browser/planview.mjs http://localhost:<dev>/ <作業用ディレクトリ>/pv`
画面の区切り（ドラッグで動かす分割線、`src/app/splitters.ts`）やレイアウトの格子を触ったら `CDP_PORT=<cdp> node tools/browser/splitters.mjs http://localhost:<dev>/ <作業用ディレクトリ>/sp`
（実際のドラッグ・矢印キー・再読み込み・ダブルクリック・狭い画面）。
（1 分弱。実クリックで切り替えて最後まで回し、`node tools/planview.mjs` と定常の値を比べる（相対 1e-5。Chrome と Node の V8 で
Math.exp・log の最後の 1 ビットが違うのでビット一致はしない）、もう一度回してビット一致、タブ、16 mm の注、亀裂の記録、URL、断面に戻る・切り替えで一時停止・
時計が表示中のビュー・未反映の編集は切り替えで反映しない・やり直すは両方、700 px。`pv-*.png` を自分で見る）。
2 次元・3 次元のタブや 3 次元の画面（`solidMode.ts`・`solidView.ts`・3 次元のワーカー・`tracker3.ts` の応力状態と破断軌跡・`tape.ts` の巻き戻し再生）を触ったら `CDP_PORT=<cdp> node tools/browser/solid.mjs http://localhost:<dev>/ <作業用ディレクトリ>/sol`
`solid`（3 次元のタブ: `active` `ready` `running` `frames` `done` `diag`（`steady` が定常の平均、SI）`geometry`（今のスタンドの。`stand` `stands` `sheetLength` も）`stand` `stands` `standResults`（済んだスタンドの `Stand3Result`）`stopped` `settings` `params` `field` `range` `url` `view`（向き・拡大・切る・ロール・`pan`・`pivot` = 回転の中心 [m]）`screenOfPoint(x, y, z)`（板の座標 [m] の画面座標）`tracks`（追っている点: 最初の亀裂・損傷最大）`explorer`（表示中の点）`screenOf(role)`（追っている点の丸の印の画面座標）`replay`（巻き戻し再生: `length` 記録した枚数・`at` 表示中の枚（生の絵なら null）・`playing`・`shown` 表示中の diag・`seek(i)` `play()` `pause()`）`video()`（記録を動画ファイルにしてダウンロード。書いたものの名前・形式・大きさ・枚数・秒を返す）`videoBusy``frameShown`（表示中のフレーム）`setDim('2'|'3')` `setField()` `run()` `drawMs()` `chartsResized()`（分割線で下のグラフの高さを変えたあと描き直す））
2 次元に戻って断面が動く・3 次元を出すと一時停止、条件の欄で 2 スタンド・定常で引き継ぎ・定常になるまでの板長・ロール偏平・圧下率一定を選んで最後まで（#1 は相対 1e-5、#2 は荷重 1 %）、条件の欄の前後張力で最後まで（`params`・URL・結果の表の行・荷重が下がる）、ロールの撓み（条件の欄のチェックとバレル長で最後まで、`settings`・URL・撓みの行）、入側の板クラウン 40 µm で最後まで（URL `crown3`、`node tools/solid.mjs --crown 40` と荷重・平坦度を比べる、結果の行、クラウン・平坦度の図が描かれる、絵とグラフの分割線の実ドラッグで `--chart-h3` が動く・ダブルクリックで戻る）、700 px。`sol-*.png` を自分で見る）。
荷重・フリクションヒルのグラフ（スラブ法の重ね描き・移動平均・凡例）を触ったら `CDP_PORT=<cdp> node tools/browser/slab-overlay.mjs http://localhost:<dev>/ <作業用ディレクトリ>/ov`
（約 40 秒。スラブ法の値を node の `karman()` と比べ、方法の外の条件の凡例、定常の移動平均の揺れ、狭い幅の凡例。`ov-*.png` を自分で見る）。
タンデムの画面（スタンドの枠・スタンドごとの表・負荷経路の色分け）を触ったら `CDP_PORT=<cdp> node tools/browser/tandem.mjs http://localhost:<dev>/ <作業用ディレクトリ>/tan`
（約 5.5 分、CPU ロックを取って回す。3 スタンドを実クリックで最後まで回して `node tools/tandem.mjs` と比べる（#1 は相対 1e-5、#2 以降は h0 を 1e-7 ずらしたときの揺れの 2 倍まで）、
枠・表・CSV・PNG・実マウス・5 スタンドの表の幅・700 px・板の破断で止まる・1 スタンドに戻す。`tandem*.png` を自分で見る）。

3 次元の GPU（`src/mpm/solid/gpu/`・`Sim3.advanceBatch`・ワーカーの `loopGpu`・「計算」の選択）を触ったら、GPU 付きの Chrome を別に上げて
`BROWSER_GPU=1 tools/browser/browser.sh start <cdp2> <作業用ディレクトリ>/chrome-gpu` → `CDP_PORT=<cdp2> node tools/browser/gpu.mjs http://localhost:<dev>/ <作業用ディレクトリ>/g`
（約 5 分。`tools/gpu/check.html` で同じ状態から 1 ステップ・1 バッチを量ごとに比べ、条件 5 通り（素・張力・ロール偏平 + 圧下率一定・撓み・損傷）を定常まで回して CPU と比べ、
画面で `gpu3=1` と無しを最後まで回して比べる。`--quick` で画面の節を飛ばす。アダプタが無ければ SKIP。CI（ubuntu）には GPU が無いので `@check` ではない）。
`BROWSER_GPU` 無しの `browser.sh` は `--disable-gpu` で、`navigator.gpu` はあってもアダプタが取れない（CPU への退避の確認に使える）。
`browser.sh` は macOS・Linux・Windows（Git Bash）で動く（Chrome は `CHROME` → 既定の場所 → PATH、GPU の旗は OS で Metal / Vulkan、`BROWSER_GPU_FLAGS` で上書き、
止めるのは lsof → ss → netstat）。カーネルはどの GPU でも動くように書く（`docs/model.md`「GPU」: 既定の制限、2 次元ディスパッチ、`select` の引数の clamp）。
複数の GPU は `requestGpuPool()`（高性能・省電力の 2 通りで取れる別々のアダプタ。1 回の圧延は分けない）。
3 次元の複数スレッド（`src/mpm/solid/team.ts`・`grid3.ts`・`Sim3` の段（`runPhase`）・ワーカーの `loopTeam`・「CPU のコア数」）を触ったら `node tools/checks/solid3-threads.mjs`（約 4 分、`@check`。`Team` の `serial` で決定的に比べる）と、
画面で `?dim=3&W3=4&L3=12&cells3=4&autorun=1&threads3=3` を最後まで回して `__mpm.solid.compute.threads === 3`・荷重が `node tools/solid.mjs --W 4` と 1e-9 で合うこと。
`solid.mjs` の節にも入っている。

レイアウトの密度（タブの行の右端の「レイアウト」標準 / コンパクト、`src/app/density.ts`・`styles.css` の「density」・`--masthead-h` の実測）を触ったら `CDP_PORT=<cdp> node tools/browser/density.mjs http://localhost:<dev>/ <作業用ディレクトリ>/dn`（約 40 秒。属性・マストヘッドの高さとトークン・罫線の上のタブ・説明文の表示・字の大きさ・グラフの高さ・再読み込み・3 次元・700 px・定常の荷重が同じ。`dn-*.png` を自分で見る）。
描画の更新（時計の下の「描画の更新」、`src/app/frameRate.ts`・ワーカーの `frame-ms`）を触ったら `CDP_PORT=<cdp> node tools/browser/frame-rate.mjs http://localhost:<dev>/`（約 1 分。断面・3 次元・平面図で実際の選択を変えて 2 秒の枚数を数え、再読み込みで残ること）。
残り時間の表示（時計の上の「残り 約 …」、`src/app/eta.ts`・`src/mpm/progress.ts`・ワーカーの `progress`）を触ったら `CDP_PORT=<cdp> node tools/browser/eta.mjs http://localhost:<dev>/ <作業用ディレクトリ>/eta`
（約 5 分。表示した残り時間を、実際に掛かった残り時間と比べる: 断面・一時停止・タンデム 2 スタンド（`handoff` 2 通り）・平面図・3 次元。`eta-section.png` を自分で見る）。

ポートは必ず渡す（既定値は無い）。`window.__mpm` は `frames` `density`（レイアウトの密度 'standard' | 'compact'。読み書き）`eta`（表示中の残り時間 [s]。速さが読めるまでは null。`plan.eta`・`solid.eta` も）`running` `ready` `done` `diag` `steady`（表示中のスタンドの定常の平均、`TandemSim` の読み。無ければ null）`cracks`
`geometry` `params` `history` `slab`（スラブ法の荷重・中立点・方法の外の理由、`delta` = 平均板厚 / 接触長、`steadyForce` = 定常の荷重をステップ数で重み付けした平均 [N/m]、`ratio` = MPM / スラブ法。定常の前と方法の外では null）`forceChart`（荷重のグラフに描いた生の値と移動平均）`explorer`（表示中の点）`tracks`（追っている点と経路）`view`（拡大率・パン・倍率・主応力の向き）
`plan`（平面図: `active` `ready` `running` `done` `diag`（`steady` が定常の平均、SI）`cracks` `settings` `url` `setMode()` `setField()` `drawMs()`）
（約 12 分、うちタンデムの節が約 9 分。実クリックでタブを移り、板幅 4 mm を最後まで回して `node tools/solid.mjs` と比べる（相対 1e-5）、巻き戻し再生（実クリックで巻き戻す・再生・一時停止・スライダーの端、再生中の色の量のタブ）、「動画に保存」で実際にダウンロードした MP4 を ffprobe で読む（枚数・幅・長さ。ffprobe が無ければ飛ばす）、色の量のタブ、実ドラッグで動かす・Shift+ドラッグで回す・動かしたあと矢印キーで画面の中央を軸に回る・ホイール・ダブルクリック、見る向き、URL、
応力状態の表と `__mpm.solid.explorer` の一致・破断軌跡の描画、亀裂になる条件（`cond` で D2 0.15）で最初の亀裂の点と役のボタンの実クリック・絵の上の丸の印（`__mpm.solid.screenOf(role)` の周りの画素の色）、
`stand` `stands` `standResults` `standFrames` `stopped`（タンデム: 表示中のスタンド（0 始まり）・スタンド数・済んだスタンドの結果・並んだ枠の状態・最後のスタンドまで行かずに止まった理由 'stalled' | 'separated' | 'lost'、ふだんは null）と
`run()` `restart()` `setField(id)` `screenOf(id)`（粒子の画面座標）`screenOfPoint(x, y)`（板の座標 [m] の画面座標）`drawMs(n)`（今のフレームを n 回描いた 1 回の ms）、
`pressing`（亀裂の印が押されている最中）`pressAgain()`（印をもう一度押す。瞬間を撮る用）を持つ。
凡例の `data-field` が今の色の量（タブの名前は短いことがあるので、待つならこちら）。

## クエリパラメータ

`?preset=standard|front-tension|central-burst|void|high-friction&h0=1&r=25&R=100&L=16&mu=0.08&tb=0&tf=0`
`&mat=spcc|s4340|al6061&damage=johnson-cook|hancock-mackenzie|cockcroft-latham|gtn|localization|none&cells=10&ms=10000`
`&yield=von-mises|gtn&nucleation=tension|always&f0=0.005&fc=0.05`
`&field=seq|eta|s1|pres|ep|damage|sxx|syy|sxy|dT|lagrange|porosity|loc|drucker&autorun=1&stopafter=<step>`
`&view=plan&W=20&wcells=10&notch=0&pfield=sxx|szz|seq|eta|damage|spread`（平面図。板幅 mm・半幅のセル数・端の切り欠きの半径 mm）
`&dim=3&W3=8&L3=12&cells3=4&ps3=1&full3=1&f3=seq|ep|pres|eta|sxx|syy|szz|damage|spread`（3 次元のタブ。板幅 mm・板の長さ mm・板厚方向のセル数（偶数 4〜8）・平面ひずみで解く・板厚の全体をロール 2 本で解く（既定は 1/4 モデル。`Sim3.fullThickness`、`tools/solid.mjs --full`、`tools/checks/solid3-full.mjs`）・色の量。
`&gpu3=1` = 1 ステップを WebGPU で（無ければ CPU。`__mpm.solid.compute` が `{compute, gpu, note, threads}`）。`&threads3=N` = CPU の 1 ステップを N 本のスレッドで（1〜論理コア数。cross-origin isolated でないページでは 1 で `note` に理由。GPU のときは使わない）。`&bend3=1&barrel3=300&support3=bearing&span3=400` = ロールの撓み（バレル長 mm・支点を軸受に・支点間距離 mm。`support3` が無ければバレルの端。`diag.rollBend`・`steady.rollBend`）。`&crown3=40` = 入側の板クラウン µm（幅方向に 2 次。`steady.crownIn`・`crownOut`・`flatness`）。ほかの条件は 2 次元と共通で、`stands`・`handoff`・`length`・`flatten`・`rollE`・`control` は 3 次元にも効く。`tb`・`tf` も効く。`crack`・`L`・`cells`・GTN は 3 次元では使わない）
`&escatter=0&ewidth=1&elen=1&eseed=1`（端の延性のばらつき。大きさ %・帯の幅 mm・相関長 mm・種。`escatter=0`（既定）で無し）
`&stands=1..5`（タンデムのスタンド数。どのスタンドも同じ条件で、圧下率は各スタンドの入側板厚に対して。断面の画面だけ）
`&length=fixed|steady`（板の長さの取り方。`steady` = 1 スタンド目の板を、定常の読みが揃うのに要る長さに自動で（`L` は使わない。決めた長さは `__mpm.params.rolling.sheetLength`）。ツールは `--length steady`）
`&flatten=none|hitchcock&rollE=206&control=gap|reduction`（ロール偏平を計算した荷重と連立・ロールのヤング率 GPa・圧下率一定 = 出側板厚が h0(1−r) になるようロールギャップを調整。既定は剛体・ギャップ一定。落ち着くまで `diag.phase === 'adjusting'`（前方・後方張力が立ち上がりきるまでも 'adjusting'）、`diag.rollRadius`・`diag.gap`・`diag.rollsSettled`）
`&handoff=done|steady`（タンデムの引き継ぎ。既定は `done` = 板が抜けてから。`steady` = 定常になったらすぐ次のスタンドへ、定常の部分を繰り返した板で。数倍速い）
`&sym=1`（板厚方向の対称モデル: y = 0 を対称面にして上半分だけ解く、ロール 1 本、点が半分で約 2 倍速い。読みは板全体の値。`__mpm.params.rolling.halfThickness`・`__mpm.geometry.halfThickness`、`__mpm.screenOfPoint(x, y)` で継ぎ目の画面座標。断面だけ。既定は全厚）
`&crack=none|dfg`（亀裂の面。既定は `dfg` = 亀裂の近くの節点で点を両側の 2 つの速度場に分け、面が開く。`none` は 1 つの速度場で、T74 より前の既定）
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
