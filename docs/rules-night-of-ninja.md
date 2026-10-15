# 忍者之夜 · 规则实现核对文档

本文档记录 `packages/games/night-of-ninja` 裁判的规则依据与核对状态。
**实现已对齐的部分**来自官方 2 人规则页（brotherwisegames.com）、Zatu how-to-play、One Board Family / BoardGameReview 评测的交叉确认。

## ✅ 已交叉确认并实现的结构

| 规则点 | 确认内容 |
|---|---|
| 人数 | 4–11 人核心规则（本实现放宽到 3 人可玩：鹤1 + 莲1 + 浪人；2 人变体未实现） |
| 家系 | 鹤之家 Crane（蓝）与 莲之家 Lotus（红），**每轮重新暗发身份** |
| 排名 | 每家系按人数取 1..k（1 最优）；奇数人数加入中立浪人（无排名） |
| 轮抽 | 每人 3 张 → 选 1 → 余牌**左传** → 从 2 张再选 1 → 弃 1，手中留 2 |
| 暗选 | 从手中暗选 1 张打出，按编号 1→6 升序结算；编号小先行动 |
| 结算顺序 | 1 间谍 → 2 通灵者 → 3 诡术师 → 4 盲眼刺客 → 5 忍者 → 6 特殊（反应/决胜） |
| 死亡 | 被杀且尚未结算的玩家，其卡牌作废；死亡只持续本回合 |
| 回合胜负 | 幸存者公开身份；**幸存者中排名最优的家系获胜**（逐位比较，缺位为劣；完全平局则双方无所得） |
| 计分 | 获胜家系全员（死活皆算）各抽 1 枚**暗置荣誉代币**；浪人存活也抽；**任一玩家达到 10+ 荣誉即个人获胜**（同时达标比数值，再平共享） |
| 卡牌身份 | 间谍=看身份；通灵者=看身份+未打出的牌；盲眼刺客=杀任意玩家；忍者=看身份后选择杀/放；镜僧=反弹刺杀；主谋=存活则家系胜 |

## ⏳ 暂定待核对（拿到实体规则书后 5 分钟核对清单）

标记于 `src/cards.ts` 的 `provisional: true`：

1. **六张诡术师的具体效果**——官方为六张各不相同的独特卡；公开资料仅确认「家牌调换」「揭露身份」两种。本实现暂定为：家牌调换 / 真相揭露 / 偷天换日（换暗牌）/ 窥魂之瞳 / 金蝉脱壳（随机换身份）/ 封印之印（无效化）。
2. **盲眼刺客/忍者的精确措辞**（是否有限制条件）。
3. **影卫**（免死反应卡）是否存在于官方 6 号槽位。
4. **荣誉代币面值分布**（暂定 1,1,1,1,2,2,2,3,3,4）与目标值 10 的精确规则、平局细则。
5. **同编号卡的同回合结算先后**（暂定按座位顺序）。
6. **牌堆构成随人数的比例**（暂定公式见 `buildDeck`）。
7. 2 人变体规则（每人操控 3 张家系牌）——未实现。

核对后只需修改 `cards.ts` 数据表与（如涉及）`referee.ts` 中对应效果分支，单元测试同步更新即可。

## 参考链接

- 官方规则书 PDF：https://fgbradleys.com/wp-content/uploads/Night-of-the-Ninja-Rulebook.pdf
- 官方两人规则：https://www.brotherwisegames.com/night-of-the-ninja-2p
- Zatu how-to-play：https://zatu.com/en-us/blogs/how-to-play/how-to-play-night-of-the-ninja
- One Board Family 评测：https://oneboardfamily.com/night-of-the-ninja-review/
- BoardGameReview 评测：https://boardgamereview.co.uk/game-reviews/night-of-the-ninja-review/
