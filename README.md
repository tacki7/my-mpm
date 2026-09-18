# MPM Rolling Lab — 冷間圧延 MPM ラボ

薄板の冷間圧延を material point method（MPM）で解き、板の中の応力状態から亀裂がどこで・いつ
生まれるかを見るブラウザアプリ。

- 2D 平面ひずみ、陽解法 MPM（2 次 B スプライン、MLS-MPM / APIC、J-bar）
- 亜弾性-塑性（J2、Johnson-Cook / Swift 硬化）
- 損傷: Johnson-Cook（応力三軸度・ひずみ速度・温度）、Hancock-MacKenzie、Cockcroft-Latham
- 剛体ロールとの Coulomb 摩擦接触、前後方張力
- 亀裂の発生点・時刻・そのときの応力状態の記録

モデルは B. Banerjee, *Material Point Method Simulations of Fragmenting Cylinders*
(arXiv:1201.2439) を参考にしている。対応と限界は [docs/model.md](docs/model.md)。

## 使い方

```bash
npm ci
npm run dev          # http://localhost:5173
npm run check        # 回帰関門
npm run sim -- --cells 6 --L 8    # ヘッドレスで 1 回圧延
```

条件は左の欄、または URL（例 `?preset=central-burst&field=eta&autorun=1`、一覧は CLAUDE.md）。

## 文書

- [docs/model.md](docs/model.md) — 式、参考文献との対応、既知の限界
- [docs/validation.md](docs/validation.md) — 検証値と測定条件
- [docs/presets.md](docs/presets.md) — 名前付きの条件と調整の状態
- [docs/design.md](docs/design.md) — 画面のデザイン
