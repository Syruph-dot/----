# 子弹系统重构实施计划

> **对于 Claude：** 必需子技能：使用 superpowers:executing-plans 来逐任务实施此计划。

**目标：** 重构子弹系统为3大类别（玩家1子弹、玩家2子弹、弹幕），区分普通/特殊子弹（玩家子弹）和可消除/不可消除（弹幕）。修复小怪被弹幕误伤的问题。

**架构：**
- `BulletCategory`：`player1` | `player2` | `barrage`
- `BulletType`：`normal` | `special`
- 碰撞检测按 `BulletCategory` 严格分离：玩家子弹只伤害敌机/Boss，弹幕只伤害玩家
- `canBeDestroyed`：仅小怪爆炸能消除/传送弹幕，**玩家子弹不能消除任何子弹**

**技术栈：** TypeScript, Canvas2D

---

## 子弹分类总览

| 来源 | Category | BulletType | canBeDestroyed | 碰撞行为 |
|------|----------|------------|---------------|---------|
| 玩家普通射击 | player1/player2 | normal | - | 造成1次伤害后消失 |
| 1级蓄力特殊攻击 | player1/player2 | special | - | 造成1次伤害，不消失 |
| 敌机子弹 | barrage | normal | **true** | 只伤害玩家 |
| 2级蓄力弹幕 | barrage | normal | **true** | 只伤害玩家，可被小怪爆炸消除 |
| 3级蓄力弹幕 | barrage | special | **false** | 只伤害玩家，不可消除 |
| Boss子弹 | player1/player2 | normal/special | - | 伤害敌方玩家 |

**消弹规则：只有小怪爆炸能消除/传送 `canBeDestroyed=true` 的弹幕，玩家子弹不能消除任何子弹！**

---

## 任务 1：定义新的子弹类型枚举

**文件：**
- 修改：`src/entities/types.ts`

**步骤 1：添加 BulletCategory 和 BulletType 枚举**

```typescript
// src/entities/types.ts

// 子弹大类
export type BulletCategory = 'player1' | 'player2' | 'barrage';

// 子弹类型（玩家子弹用：普通/特殊）
export type BulletType = 'normal' | 'special';
```

**步骤 2：验证**
运行：`npx tsc --noEmit src/entities/types.ts`

---

## 任务 2：重构 Bullet 类

**文件：**
- 修改：`src/core/Bullet.ts`

**步骤 1：用新的分类替换旧属性**

```typescript
export class Bullet {
  x: number;
  y: number;
  width = 4;
  height = 10;
  vx: number;
  vy: number;
  active = true;

  category: BulletCategory;    // 子弹大类
  bulletType: BulletType;     // 子弹类型
  canBeDestroyed: boolean;     // 可消属性（仅弹幕有效，小怪爆炸影响可消弹幕）
  damage: number;

  // 转移相关
  private isTransferring = false;
  private transferTime = 0;
  private transferDuration = 750;
  private targetX = 0;
  private targetY = 0;
  private startX = 0;
  private startY = 0;

  constructor(x: number, y: number, vx: number, vy: number,
              category: BulletCategory, bulletType: BulletType,
              canBeDestroyed: boolean,
              width = 4, height = 10, damage = 10) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.category = category;
    this.bulletType = bulletType;
    this.canBeDestroyed = canBeDestroyed;
    this.width = width;
    this.height = height;
    this.damage = damage;
  }
}
```

**步骤 2：更新 render() 方法**

```typescript
render(ctx: CanvasRenderingContext2D) {
  if (this.isTransferring) {
    ctx.fillStyle = 'rgba(255, 255, 0, 0.5)';
    ctx.globalAlpha = 0.5;
  } else if (this.bulletType === 'special') {
    ctx.fillStyle = '#ffff00';  // 黄色特殊子弹
  } else if (this.category === 'barrage') {
    ctx.fillStyle = this.canBeDestroyed ? '#ff00ff' : '#8800ff';  // 紫色可消，深紫不可消
  } else {
    ctx.fillStyle = this.category === 'player1' ? '#00ffff' : '#ff6600';
  }

  ctx.fillRect(this.x, this.y, this.width, this.height);
  ctx.globalAlpha = 1;
}
```

**步骤 3：更新 startTransfer() 方法**

```typescript
startTransfer(targetX: number, targetY: number, duration: number, targetCategory: BulletCategory) {
  this.isTransferring = true;
  this.transferDuration = duration;
  this.targetX = targetX;
  this.targetY = targetY;
  this.startX = this.x;
  this.startY = this.y;
  this.category = targetCategory;
  this.active = true;
}
```

**步骤 4：验证**
运行：`npx tsc --noEmit src/core/Bullet.ts`

---

## 任务 3：更新 Player 类中的子弹创建

**文件：**
- 修改：`src/core/Player.ts`

**步骤 1：更新 shoot() 方法 - 普通子弹**

```typescript
shoot(game: Game) {
  const currentTime = Date.now();
  if (currentTime - this.lastShootTime < this.shootCooldown) return;

  this.lastShootTime = currentTime;

  const category = this.side === 'left' ? 'player1' : 'player2';
  const bullet = new Bullet(
    this.x + this.width / 2 - 2,
    this.y,
    0,
    -10,
    category,
    'normal',
    false,  // 玩家子弹没有canBeDestroyed概念
    4,
    10,
    10
  );

  game.addBullet(bullet);
}
```

**步骤 2：更新 useLevel1Skill() - 特殊子弹（不消失）**

```typescript
case 'scatter':
  for (let i = -2; i <= 2; i++) {
    const bullet = new Bullet(
      this.x + this.width / 2,
      this.y,
      i * 2,
      -10,
      category,
      'special',
      false
    );
    game.addBullet(bullet);
  }
  break;
case 'laser':
  const laser = new Bullet(
    this.x + this.width / 2,
    this.y,
    0,
    -15,
    category,
    'special',
    false,
    10,
    100
  );
  game.addBullet(laser);
  break;
case 'tracking':
  for (let i = 0; i < 3; i++) {
    const missile = new Bullet(
      this.x + this.width / 2 + (i - 1) * 20,
      this.y,
      0,
      -8,
      category,
      'special',
      false
    );
    game.addBullet(missile);
  }
  break;
```

**步骤 3：更新 useLevel2Skill() - 可消除弹幕**

```typescript
const bullet = new Bullet(
  targetX + (Math.random() - 0.5) * 200,
  0,
  (Math.random() - 0.5) * 2,
  3 + Math.random() * 2,
  'barrage',
  'normal',
  true  // 可被小怪爆炸消除
);
```

**步骤 4：更新 useLevel3Skill() - 不可消除弹幕**

```typescript
const bullet = new Bullet(
  targetX + (Math.random() - 0.5) * 200,
  0,
  (Math.random() - 0.5) * 2,
  3 + Math.random() * 2,
  'barrage',
  'special',
  false  // 不可被消除
);
```

**步骤 5：验证**
运行：`npx tsc --noEmit src/core/Player.ts`

---

## 任务 4：更新 Enemy 类

**文件：**
- 修改：`src/core/Enemy.ts`

**步骤 1：更新 shoot() - 敌机发射可消除弹幕**

```typescript
private shoot(game: Game) {
  const bullet = new Bullet(
    this.x + this.width / 2 - 2,
    this.y + this.height,
    0,
    5,
    'barrage',
    'normal',
    true  // 可被消除
  );

  game.addBullet(bullet);
}
```

**步骤 2：更新 update() - 限制上半平面发射**

```typescript
update(_deltaTime: number, game: Game) {
  this.y += this.speed;

  if (this.y > game.getScreenHeight() * 0.42) {
    this.active = false;
    return;
  }

  const currentTime = Date.now();
  // 只在上半平面发射子弹
  if (currentTime - this.lastShootTime > this.shootCooldown && this.y < game.getScreenHeight() * 0.5) {
    this.lastShootTime = currentTime;
    this.shoot(game);
  }
}
```

**步骤 3：验证**
运行：`npx tsc --noEmit src/core/Enemy.ts`

---

## 任务 5：更新 Boss 类

**文件：**
- 修改：`src/core/Boss.ts`

**步骤 1：更新所有 shoot 方法 - Boss 发射玩家子弹**

```typescript
private shootScatter(game: Game) {
  const category = this.side === 'left' ? 'player1' : 'player2';
  for (let i = -2; i <= 2; i++) {
    const bullet = new Bullet(
      this.x + this.width / 2,
      this.y + this.height,
      i * 1.5,
      4,
      category,
      'normal',
      false
    );
    game.addBullet(bullet);
  }
}

private shootLaser(game: Game) {
  const category = this.side === 'left' ? 'player1' : 'player2';
  const bullet = new Bullet(
    this.x + this.width / 2,
    this.y + this.height,
    0,
    8,
    category,
    'special',
    false,
    6,
    30
  );
  game.addBullet(bullet);
}

private shootTracking(game: Game) {
  const category = this.side === 'left' ? 'player1' : 'player2';
  const bullet = new Bullet(
    this.x + this.width / 2,
    this.y + this.height,
    (Math.random() - 0.5) * 2,
    5,
    category,
    'normal',
    false
  );
  game.addBullet(bullet);
}
```

**步骤 2：验证**
运行：`npx tsc --noEmit src/core/Boss.ts`

---

## 任务 6：重构 Game.ts 碰撞检测

**文件：**
- 修改：`src/core/Game.ts`

**步骤 1：完全重写 checkCollisions() 方法**

```typescript
private checkCollisions() {
  for (let bullet of this.bullets) {
    if (!bullet.active) continue;

    // ===== 玩家子弹 (player1/player2)：只伤害敌机/Boss =====
    if (bullet.category === 'player1' || bullet.category === 'player2') {
      const targetSide = bullet.category === 'player1' ? 'left' : 'right';

      // 检测与敌机碰撞
      for (let enemy of this.enemies.filter(e => e.side === targetSide)) {
        if (this.isColliding(bullet, enemy)) {
          enemy.health -= bullet.damage;
          // 特殊子弹不消失，普通子弹消失
          if (bullet.bulletType === 'normal') {
            bullet.active = false;
          }
          if (enemy.health <= 0) {
            enemy.active = false;
            this.onEnemyKilled(enemy, targetSide);
          }
          break;  // 子弹只造成一次伤害
        }
      }

      // 检测与Boss碰撞
      if (bullet.active && this.boss && this.boss.side === targetSide) {
        if (this.isColliding(bullet, this.boss)) {
          this.boss.health -= bullet.damage;
          if (bullet.bulletType === 'normal') {
            bullet.active = false;
          }
          if (this.boss.health <= 0) {
            const bossSide = this.boss.side;
            this.removeBoss();
            this.onBossKilled(bossSide);
          }
        }
      }
      continue;  // 玩家子弹不检测与玩家碰撞，不消除任何子弹
    }

    // ===== 弹幕 (barrage)：只伤害玩家 =====
    if (bullet.category === 'barrage') {
      const targetPlayer = bullet.side === 'left' ? this.player1 : this.player2;

      if (targetPlayer && this.isColliding(bullet, targetPlayer)) {
        targetPlayer.health -= bullet.damage;
        bullet.active = false;
      }
    }
  }
  // 注意：玩家子弹不能消除弹幕！消弹只能通过小怪爆炸！
}
```

**步骤 2：更新 triggerExplosion() - 小怪爆炸消除并传送可消除弹幕**

```typescript
private triggerExplosion(x: number, y: number, side: PlayerSide) {
  // 找出范围内可被消除的弹幕
  const destroyableNearby = this.bullets.filter(b => {
    const dist = Math.sqrt((b.x - x) ** 2 + (b.y - y) ** 2);
    return dist < 50 && b.category === 'barrage' && b.canBeDestroyed;
  });

  destroyableNearby.forEach(b => {
    b.active = false;
  });

  // 40%概率传送被消除的弹幕到敌方
  if (Math.random() < 0.4 && destroyableNearby.length > 0) {
    const targetCategory = side === 'left' ? 'player2' : 'player1';
    const targetX = targetCategory === 'player1'
      ? Math.random() * (this.SCREEN_WIDTH * 0.45)
      : this.SCREEN_WIDTH * 0.55 + Math.random() * (this.SCREEN_WIDTH * 0.45);
    const targetY = Math.random() * (this.SCREEN_HEIGHT * 0.4);

    destroyableNearby.forEach(b => {
      b.startTransfer(targetX, targetY, 750, targetCategory);
      this.bullets.push(b);
    });
  }
}
```

**步骤 3：验证**
运行：`npx tsc --noEmit`

---

## 任务 7：构建并验证

**步骤 1：运行完整构建**
运行：`pnpm run build`

**步骤 2：启动开发服务器**
运行：`pnpm dev`

**步骤 3：手动测试**
- [ ] 玩家普通射击击杀敌机后子弹消失
- [ ] 1级特殊攻击击中敌机后子弹不消失
- [ ] 敌机进入下半平面后不再发射子弹
- [ ] 弹幕击中玩家扣血
- [ ] 玩家子弹**不会**消除弹幕
- [ ] 不可消除弹幕不被小怪爆炸消除
- [ ] 小怪爆炸时消除附近可消除弹幕，有概率传送到敌方

---

## 变更摘要

| 文件 | 变更 |
|------|------|
| `src/entities/types.ts` | 添加 `BulletCategory` 和 `BulletType` |
| `src/core/Bullet.ts` | 重构属性系统 |
| `src/core/Player.ts` | 更新所有子弹创建 |
| `src/core/Enemy.ts` | 敌机子弹改为弹幕，添加上半平面限制 |
| `src/core/Boss.ts` | Boss子弹改为玩家子弹类 |
| `src/core/Game.ts` | 重写碰撞和爆炸逻辑，**移除玩家子弹消除弹幕的逻辑** |
