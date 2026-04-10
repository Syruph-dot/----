# 神经网络训练规格

这份文档定义了适合本项目的神经网络输入、输出、奖励和训练路线。目标不是直接做像素级端到端学习，而是先把当前的规则 AI、自博弈日志和 headless 批次结果，转成可训练的结构化数据。

## 1. 推荐路线

先做行为克隆，再做自博弈强化学习。

1. 先用现有 `trainingEvents` 做行为克隆，得到一个能稳定跑的初始策略。
2. 再切到 self-play / league self-play，用 PPO 或者类似的 actor-critic 方法继续优化。
3. 如果你更想做搜索型方法，再并行试 CMA-ES、NEAT、OpenAI-ES。

对于这类弹幕游戏，结构化状态通常比原始像素更快收敛，也更容易调试。

## 2. 输入设计

建议把输入拆成 4 层：标量状态、实体槽位、历史记忆、动作掩码。

### 2.1 标量状态

这些特征每帧都存在，适合做主干输入。

| 类别 | 特征 | 建议归一化 |
| --- | --- | --- |
| 自身 | `x`, `y` | 除以本 side viewport 的宽高 |
| 自身 | `health` | 除以 100 |
| 自身 | `bombs` | 除以 2 或者截断到 `[0, 1]` |
| 自身 | `chargeMax` | 除以 `maxCharge` |
| 自身 | `currentCharge` | 除以 `maxCharge` |
| 对手 | `x`, `y` | 除以对手 viewport 的宽高 |
| 对手 | `health` | 除以 100 |
| Boss | 是否存在 | 0/1 |
| Boss | `x`, `y` | 除以 viewport 的宽高 |
| Boss | `healthRatio` | `health / maxHealth` |
| 场地 | `screenWidth`, `screenHeight` | 可以固定，不一定要输入 |
| 场地 | `side`, `margin` | 可以做成常量，不一定要输入 |
| 威胁 | `currentThreat` | 线性裁剪到 `[0, 1]` 或 log 压缩 |
| 威胁 | `nearbyBulletCount` | 除以一个上限值，比如 20 |
| 决策历史 | 上一步动作、上一步 threat | 适合做 recurrent 输入 |

### 2.2 实体槽位

复杂环境里，实体是最有价值的输入。建议按威胁排序，只保留 top-K。

#### 子弹槽位

建议 `K = 12`，优先保留最危险的弹幕。

每个子弹特征建议包括：

| 特征 | 说明 |
| --- | --- |
| `dx`, `dy` | 相对玩家中心的位置，按 viewport 归一化 |
| `vx`, `vy` | 子弹速度，按 viewport / 秒归一化 |
| `width`, `height` | 按 viewport 归一化 |
| `damage` | 按一个上限值裁剪 |
| `isBeamLike` | 0/1 |
| `isSegmentLaser` | 0/1 |
| `isWarning` | 0/1 |
| `canBeDestroyed` | 0/1 |
| `category` | barrage / player1 / player2，可做 one-hot |

#### 敌机槽位

建议 `K = 8`，按与玩家的距离或预测威胁排序。

每个敌机特征建议包括：

| 特征 | 说明 |
| --- | --- |
| `dx`, `dy` | 相对玩家中心的位置 |
| `width`, `height` | 归一化尺寸 |
| `healthRatio` | `health / maxHealth` |
| `side` | left / right one-hot |

#### Boss 槽位

Boss 单独成槽，不要和普通敌机混在一起。

| 特征 | 说明 |
| --- | --- |
| `present` | 0/1 |
| `dx`, `dy` | 相对玩家中心的位置 |
| `healthRatio` | `health / maxHealth` |
| `canTakeDamage` | 0/1 |
| `side` | 左 / 右 one-hot |

### 2.3 历史记忆

如果你先做 MLP，建议堆叠最近 4 到 8 帧；如果你做 GRU/LSTM，就只要当前帧。

推荐的历史输入：

- 上一帧动作
- 上一帧 `currentThreat`
- 上一帧 `nearbyBulletCount`
- 最近 3 到 5 帧的 `health` 变化量

## 3. 输出设计

这类游戏更适合多头输出，不要把所有动作合并成一个超大离散空间。

### 3.1 推荐动作头

| 动作头 | 类别数 | 说明 |
| --- | --- | --- |
| 移动头 | 9 | `stay`, `left`, `right`, `up`, `down`, `up-left`, `up-right`, `down-left`, `down-right` |
| 开火头 | 2 | `keepGun`, `stopGun` |
| 技能头 | 6 | `none`, `skill1`, `skill2`, `skill3`, `skill4`, `bomb` |

如果你想更贴近现在的规则 AI，开火头更适合对应“是否存在可击打对象”的语义。运行时事件会记录 `fireTargetAvailable` 和 `fireBlockedReason`，无目标时用 `noTarget` 表示“当前不该普攻”；训练数据里仍然可以把这个阻断映射回二分类火力头。

### 3.2 动作掩码

建议做 mask，不然网络会频繁输出无效动作。

- 技能不可用时，mask 掉对应技能。
- 蓄力中或冷却中时，mask 掉技能头里会导致冲突的选项。
- 如果当前已经靠近边界，可以弱化或 mask 掉明显越界的移动方向。

## 4. 奖励设计

如果你做行为克隆，奖励不是第一优先级。
如果你做强化学习，奖励要尽量简单，避免过度 shaping。

建议的 reward 结构：

| 事件 | 奖励 |
| --- | --- |
| 每存活一小步 | `+0.01` 到 `+0.03` |
| 命中敌机 | 与伤害成比例的小正奖励 |
| 击杀敌机 | 中等奖励 |
| 清弹 | 小奖励 |
| 造成 Boss 伤害 | 中等奖励 |
| 击杀 Boss | 大奖励 |
| 自己受伤 | 负奖励 |
| 自己死亡 | 大负奖励 |
| 获胜 | 大奖励 |
| 失败 | 大负奖励 |

建议把“生存”和“赢”放在主奖励，把“清弹”“连击”“躲避激光”放在辅助奖励。不要让辅助奖励盖过胜负本身。

## 5. 模型建议

### 5.1 起步模型

- 结构化输入 + 2 到 3 层 MLP
- hidden size 可以从 128 或 256 开始
- 再接一个 GRU/LSTM 处理时间依赖

### 5.2 进阶模型

- 如果实体数量波动很大，可以把子弹和敌机做成 set encoder / attention encoder
- 如果你未来想吃像素，再考虑 CNN + 结构化分支的双塔网络

### 5.3 训练顺序

1. 行为克隆预热。
2. self-play PPO 微调。
3. 加入 league / pool 对手，避免策略坍塌。
4. 如果想要多样策略，再做质量-多样性搜索或 novelty search。

## 6. 遗传 / 搜索方法

这类方法适合你现在的 headless 批处理环境。

| 方法 | 适用场景 | 备注 |
| --- | --- | --- |
| CMA-ES | 参数不多、评估很便宜 | 很适合直接调策略参数 |
| OpenAI-ES / Sep-CMA-ES | 并行评估方便 | 对批量 headless 很友好 |
| NEAT | 想连结构一起进化 | 适合小网络和早期探索 |
| PBT | 训练过程中动态调超参数 | 更像训练调度，不是纯进化 |
| Novelty Search / QD | 想保留多种打法 | 适合生成不同风格的 AI |

如果目标是“先出一个能打的 AI”，推荐顺序通常是：

1. 行为克隆。
2. PPO self-play。
3. CMA-ES / PBT 调参。
4. NEAT 或 novelty search 做风格探索。

## 7. 当前项目里建议补的日志字段

你现在的 tick 日志已经有不少信息，但如果要直接喂给神经网络，最好再补这些：

- `observation_version`
- `self_state`
- `opponent_state`
- `boss_state`
- `bullet_slots`
- `enemy_slots`
- `arena_state`
- `previous_action`
- `previous_threat`

当前的 `trainingEvents` 和 `Game.getMatchSummary()` 已经够做第一版数据集了，但上面这些字段会明显减少你后面清洗数据的工作量。

## 8. 最小落地方案

如果你只想先落地一版，建议这样做：

1. 继续用当前 headless runner 生成 self-play 数据。
2. 给每个 tick 增加结构化 observation。
3. 先训练一个 BC 模型，目标只学“移动 + 停抢 + 技能选择”。
4. 再接 PPO self-play 做提升。

## 9. 目前已经接上的实现

当前仓库里已经落地了第一版闭环：

1. `scripts/prepare_bc_dataset.py` 会把 headless JSONL 转成 BC 数据集，输出 `train.jsonl`、`val.jsonl` 和 `metadata.json`。
2. `scripts/train_bc.py` 会读取数据集，训练多头 MLP，并导出 `policy.pt`、`policy.json` 和 `training-metrics.json`。
3. `src/systems/policy/jsonPolicy.ts` 提供了运行时推理适配器，`policy.json` 可以直接被游戏加载。
4. `src/main.ts` 的开局面板已经支持选择 policy 文件，所以训练后的模型可以直接回到人机对战。
5. `pnpm run policy:smoke -- --policy <policy.json>` 可以快速验证模型文件是否可读、可推理。
6. 原生模型也可以直接加载：`.onnx` 或 TFJS `model.json` 旁边放 `policy.meta.json`，或者直接复用训练导出的 `policy.json` 作为共享 metadata。

推荐的最小闭环命令如下：

```bash
pnpm run headless -- --episodes 20 --output-dir training-output --format jsonl --split rare-full
python scripts/prepare_bc_dataset.py --input training-output --output-dir bc-dataset
python scripts/train_bc.py --dataset-dir bc-dataset --output-dir bc-model --epochs 12 --batch-size 64
pnpm run policy:smoke -- --policy bc-model/policy.json
```
