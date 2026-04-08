import { BulletCategory, BulletType, PlayerSide } from '../entities/types';

export class Bullet {
  x: number;
  y: number;
  width = 4;
  height = 10;
  vx: number;
  vy: number;
  active = true;
  // 标记此子弹是否被扩张力场消除（用于决定是否计入蓄力）
  destroyedByExpandingField = false;

  // 记录此子弹对目标的最后命中时间（ms），用于实现可恢复的命中冷却
  private hitTimestamps: WeakMap<object, number> = new WeakMap<object, number>();

  category: BulletCategory;
  bulletType: BulletType;
  canBeDestroyed: boolean;
  damage: number;
  side: PlayerSide;  // 弹幕需要side来标识属于哪方

  private isTransferring = false;
  private transferTime = 0;
  private transferDuration = 750;
  private targetX = 0;
  private targetY = 0;
  private startX = 0;
  private startY = 0;
  private postTransferAimTarget: { x: number; y: number } | null = null;

  // Laser-specific state: 持续型激光，跟随一个目标（通常是发射者），持续若干毫秒，并按间隔重置命中记录以允许重复受击
  private isLaser = false;
  private laserDuration = 1500; // ms
  private laserElapsed = 0;
  private laserResetInterval = 400; // ms
  private followTarget: { x: number; y: number; width: number; height: number } | null = null;
  // 报警 / 预警标记（用于在屏幕上闪烁提示，不造成伤害）
  isWarning = false;
  // 激光扩展方向与参数
  private laserOrigin: 'top' | 'bottom' = 'top';
  private laserOriginY = -10; // 对于 bottom-origin 的激光，设置起点 Y
  private laserFadeDuration = 150; // ms，用于在激光结束前淡出
  private laserFollowX = true; // 是否随 followTarget 的 X 轴移动

  // 越界保留时间：用于“出屏后延迟删除”的发射器
  private outOfBoundsGracePeriod = 0;
  private outOfBoundsSince: number | null = null;

  // 线段激光：激光头先移动，激光尾按长度/速度推导的延迟开始移动
  private isSegmentLaser = false;
  private segmentOriginX = 0;
  private segmentOriginY = 0;
  private segmentDirX = 0;
  private segmentDirY = 1;
  private segmentSpeedPxPerSecond = 0;
  private segmentLengthPx = 0;
  private segmentTailDelayMs = 0;
  private segmentElapsedMs = 0;
  private segmentLifetimeMs = 2000;
  private segmentThicknessPx = 8;
  private segmentHeadX = 0;
  private segmentHeadY = 0;
  private segmentTailX = 0;
  private segmentTailY = 0;

  constructor(x: number, y: number, vx: number, vy: number,
              category: BulletCategory, bulletType: BulletType,
              canBeDestroyed: boolean,
              width = 4, height = 10, damage = 10,
              side: PlayerSide = 'left') {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.category = category;
    this.bulletType = bulletType;
    this.canBeDestroyed = canBeDestroyed;
    if (category === 'barrage') {
      this.width = width * 1.5;
      this.height = height * 1.5;
      this.vx = vx * 0.75;
      this.vy = vy * 0.75;
    } else {
      this.width = width;
      this.height = height;
    }
    this.damage = damage;
    this.side = side;
  }

  update(deltaTime: number) {
    if (this.isTransferring) {
      this.transferTime += deltaTime;

      if (this.transferTime >= this.transferDuration) {
        this.x = this.targetX;
        this.y = this.targetY;
        this.isTransferring = false;
        this.transferTime = 0;

        const speed = (3 + Math.random() * 5) * 0.75;
        // 随机角弹：33% 概率朝该版面玩家方向，附加左右 ±16° 偏移；其余保持原始散射。
        const aimOffsetDeg = 16;
        let angleDeg: number;
        if (this.postTransferAimTarget && Math.random() < 0.33) {
          const targetDx = this.postTransferAimTarget.x - this.x;
          const targetDy = this.postTransferAimTarget.y - this.y;
          const targetAngleRad = Math.atan2(targetDx, targetDy);
          const targetAngleDeg = (targetAngleRad * 180) / Math.PI;
          angleDeg = targetAngleDeg + (Math.random() * (aimOffsetDeg * 2) - aimOffsetDeg);
        } else {
          const maxAngleDeg = 37;
          angleDeg = Math.random() * (maxAngleDeg * 2) - maxAngleDeg;
        }
        const angle = (angleDeg * Math.PI) / 180;
        // 使用 (sin, cos) 映射，使 angle=0 时向下
        this.vx = Math.sin(angle) * speed;
        this.vy = Math.cos(angle) * speed;
        this.postTransferAimTarget = null;
      } else {
        const progress = this.transferTime / this.transferDuration;
        this.x = this.startX + (this.targetX - this.startX) * progress;
        this.y = this.startY + (this.targetY - this.startY) * progress;
      }
    } else {
      if (this.isSegmentLaser) {
        this.segmentElapsedMs += deltaTime;

        const headDistance = this.segmentSpeedPxPerSecond * (this.segmentElapsedMs / 1000);
        const tailElapsed = Math.max(0, this.segmentElapsedMs - this.segmentTailDelayMs);
        const tailDistance = this.segmentSpeedPxPerSecond * (tailElapsed / 1000);

        this.segmentHeadX = this.segmentOriginX + this.segmentDirX * headDistance;
        this.segmentHeadY = this.segmentOriginY + this.segmentDirY * headDistance;
        this.segmentTailX = this.segmentOriginX + this.segmentDirX * tailDistance;
        this.segmentTailY = this.segmentOriginY + this.segmentDirY * tailDistance;

        const minX = Math.min(this.segmentHeadX, this.segmentTailX);
        const maxX = Math.max(this.segmentHeadX, this.segmentTailX);
        const minY = Math.min(this.segmentHeadY, this.segmentTailY);
        const maxY = Math.max(this.segmentHeadY, this.segmentTailY);
        const halfThickness = this.segmentThicknessPx / 2;

        this.x = minX - halfThickness;
        this.y = minY - halfThickness;
        this.width = Math.max(this.segmentThicknessPx, maxX - minX + this.segmentThicknessPx);
        this.height = Math.max(this.segmentThicknessPx, maxY - minY + this.segmentThicknessPx);

        if (this.segmentElapsedMs >= this.segmentLifetimeMs) {
          this.active = false;
        }
      } else if (this.isLaser) {
        // 激光每帧更新计时器并跟随发射者位置（可选择是否跟随 X），激光可以从顶部或底部延伸到目标中心位置
        this.laserElapsed += deltaTime;

        if (this.followTarget) {
          const centerX = this.followTarget.x + this.followTarget.width / 2;
          const centerY = this.followTarget.y + this.followTarget.height / 2;
          if (this.laserFollowX) {
            this.x = centerX - this.width / 2;
          }

          if (this.laserOrigin === 'top') {
            // 从屏幕顶部向下延伸，起点略在屏幕外
            this.y = -10;
            this.height = Math.max(4, centerY - this.y);
          } else {
            // 从屏幕底部向上延伸：激光的矩形应从目标中心开始，向下延伸到屏幕底部
            this.y = Math.max(0, Math.min(centerY, this.laserOriginY - 4));
            this.height = Math.max(4, this.laserOriginY - centerY);
          }
        }

        if (this.laserElapsed >= this.laserDuration) {
          this.active = false;
        }
      } else {
        this.x += this.vx;
        this.y += this.vy;
      }
    }
  }

  startLaser(
    followTarget: { x: number; y: number; width: number; height: number } | null,
    duration = 1500,
    resetInterval = 400,
    laserWidth = 10,
    options?: { origin?: 'top' | 'bottom'; originY?: number; followX?: boolean; fadeDuration?: number }
  ) {
    this.isLaser = true;
    this.followTarget = followTarget;
    this.laserDuration = duration;
    this.laserResetInterval = resetInterval;
    this.laserElapsed = 0;
    this.width = laserWidth;
    this.height = 0; // 在 update 中计算
    this.vx = 0;
    this.vy = 0;
    this.active = true;
    this.clearHitTargets();

    options = options || {};
    this.laserOrigin = options.origin || 'top';
    this.laserOriginY = typeof options.originY === 'number' ? options.originY : -10;
    this.laserFollowX = options.followX !== undefined ? !!options.followX : true;
    this.laserFadeDuration = typeof options.fadeDuration === 'number' ? options.fadeDuration : Math.max(50, Math.min(300, Math.floor(this.laserDuration * 0.25)));
  }

  startSegmentLaser(
    angleDeg: number,
    speedPxPerSecond: number,
    lengthPx: number,
    thicknessPx = 8,
    lifetimeMs = 2200
  ) {
    const angleRad = (angleDeg * Math.PI) / 180;

    this.isSegmentLaser = true;
    this.isLaser = false;
    this.isTransferring = false;

    this.segmentOriginX = this.x;
    this.segmentOriginY = this.y;
    this.segmentDirX = Math.sin(angleRad);
    this.segmentDirY = Math.cos(angleRad);
    this.segmentSpeedPxPerSecond = Math.max(1, speedPxPerSecond);
    this.segmentLengthPx = Math.max(1, lengthPx);
    this.segmentTailDelayMs = (this.segmentLengthPx / this.segmentSpeedPxPerSecond) * 1000;
    this.segmentElapsedMs = 0;
    this.segmentLifetimeMs = Math.max(lifetimeMs, this.segmentTailDelayMs + 200);
    this.segmentThicknessPx = Math.max(2, thicknessPx);

    this.segmentHeadX = this.segmentOriginX;
    this.segmentHeadY = this.segmentOriginY;
    this.segmentTailX = this.segmentOriginX;
    this.segmentTailY = this.segmentOriginY;

    this.vx = 0;
    this.vy = 0;
    this.width = this.segmentThicknessPx;
    this.height = this.segmentThicknessPx;
    this.active = true;
    this.clearHitTargets();
  }

  configureOutOfBoundsGracePeriod(graceMs: number) {
    this.outOfBoundsGracePeriod = Math.max(0, graceMs);
    this.outOfBoundsSince = null;
  }

  shouldCullOutOfBounds(isOutOfBounds: boolean): boolean {
    if (!isOutOfBounds) {
      this.outOfBoundsSince = null;
      return false;
    }

    if (this.outOfBoundsGracePeriod <= 0) {
      return true;
    }

    const now = Date.now();
    if (this.outOfBoundsSince === null) {
      this.outOfBoundsSince = now;
      return false;
    }

    return now - this.outOfBoundsSince >= this.outOfBoundsGracePeriod;
  }

  isTransferringState(): boolean {
    return this.isTransferring;
  }

  hasHit(target: object): boolean {
    const last = this.hitTimestamps.get(target);
    if (!last) return false;
    // 对于激光，允许在间隔后再次命中；对于其他特殊子弹，视为一次性命中（cooldown 无限）
    const cooldown = this.isLaser ? this.laserResetInterval : Number.POSITIVE_INFINITY;
    return (Date.now() - last) < cooldown;
  }

  markHit(target: object): void {
    this.hitTimestamps.set(target, Date.now());
  }

  render(ctx: CanvasRenderingContext2D) {
    ctx.save();
    if (this.isTransferring) {
      const pulse = 0.45 + 0.25 * Math.sin(Date.now() / 60);
      ctx.globalAlpha = pulse;
      ctx.fillStyle = 'rgba(255, 209, 102, 0.85)';
      this.drawDiamond(ctx, this.x, this.y, this.width * 2, this.height * 1.8, true);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 1;
      this.drawDiamond(ctx, this.x - this.width * 0.1, this.y - this.height * 0.05, this.width * 2.2, this.height * 2.0, false);
      ctx.restore();
      return;
    }
    // 预警效果：在对方屏幕底部闪烁提示，不造成伤害
    if (this.isWarning) {
      const pulse = 0.45 + 0.35 * Math.sin(Date.now() / 120);
      ctx.globalAlpha = pulse;
      ctx.fillStyle = this.side === 'left' ? 'rgba(89, 240, 255, 0.95)' : 'rgba(255, 111, 142, 0.95)';
      // 绘制一个简单的底部矩形作为预警标记
      ctx.fillRect(this.x, this.y - this.height, this.width, this.height);
      ctx.restore();
      return;
    }

    if (this.isSegmentLaser) {
      ctx.strokeStyle = 'rgba(255, 138, 110, 0.92)';
      ctx.lineWidth = this.segmentThicknessPx;
      ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(255, 138, 110, 0.45)';
      ctx.shadowBlur = 10;

      ctx.beginPath();
      ctx.moveTo(this.segmentTailX, this.segmentTailY);
      ctx.lineTo(this.segmentHeadX, this.segmentHeadY);
      ctx.stroke();

      ctx.fillStyle = 'rgba(255, 245, 220, 0.95)';
      ctx.beginPath();
      ctx.arc(this.segmentHeadX, this.segmentHeadY, Math.max(2, this.segmentThicknessPx * 0.33), 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
      return;
    }

    if (this.isLaser) {
      // 计算淡出 alpha
      const fadeStart = Math.max(0, this.laserDuration - this.laserFadeDuration);
      let alpha = 1;
      if (this.laserElapsed >= fadeStart) {
        alpha = Math.max(0, (this.laserDuration - this.laserElapsed) / this.laserFadeDuration);
      }
      ctx.globalAlpha = alpha;

      const gradient = ctx.createLinearGradient(this.x, this.y, this.x + this.width, this.y);
      gradient.addColorStop(0, 'rgba(255, 209, 102, 0.08)');
      gradient.addColorStop(0.5, 'rgba(255, 111, 142, 0.88)');
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0.08)');
      ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.fillRect(this.x - this.width * 1.4, this.y, this.width * 3.8, this.height);
      ctx.fillStyle = gradient;
      ctx.fillRect(this.x, this.y, this.width, this.height);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(this.x, this.y, this.width, this.height);
      ctx.restore();
      return;
    }

    const palette = this.getPalette();
    ctx.fillStyle = palette.core;
    ctx.strokeStyle = palette.edge;
    ctx.lineWidth = 1;
    ctx.shadowColor = palette.glow;
    ctx.shadowBlur = 8;

    // 根据速度方向旋转子弹，使其朝向运动方向
    const cx = this.x + this.width / 2;
    const cy = this.y + this.height / 2;
    const vx = this.vx || 0;
    const vy = this.vy || 0;
    const speed = Math.hypot(vx, vy);

    if (speed > 0.0001) {
      const angle = Math.atan2(vy, vx);
      // 使高度方向对齐运动方向：旋转角度为 angle + 90°
      ctx.translate(cx, cy);
      ctx.rotate(angle + Math.PI / 2);
      this.drawProjectile(ctx);
    } else {
      ctx.translate(cx, cy);
      this.drawProjectile(ctx);
    }

    ctx.restore();
  }

  startTransfer(
    targetX: number,
    targetY: number,
    duration: number,
    _targetCategory: BulletCategory,
    targetSide: PlayerSide,
    aimTarget?: { x: number; y: number }
  ) {
    this.isTransferring = true;
    this.transferDuration = duration;
    this.targetX = targetX;
    this.targetY = targetY;
    this.startX = this.x;
    this.startY = this.y;
    // 保持原始类别（弹幕），不要把它变成玩家子弹，仍然移动到目标 side
    this.side = targetSide;
    this.active = true;
    // 从力场/外部消除状态重置标记
    this.destroyedByExpandingField = false;
    this.postTransferAimTarget = aimTarget ?? null;
    // 清除以往的命中记录，确保转移后可以对新目标造成伤害
    this.clearHitTargets();
  }

  clearHitTargets(): void {
    // 重新初始化 WeakMap
    // @ts-ignore 私有字段重置
    this.hitTimestamps = new WeakMap<object, number>();
  }

  private getPalette() {
    if (this.isTransferring) {
      return { core: 'rgba(255, 209, 102, 0.9)', edge: 'rgba(255, 255, 255, 0.5)', glow: 'rgba(255, 209, 102, 0.3)' };
    }

    if (this.bulletType === 'special') {
      return this.category === 'player1'
        ? { core: 'rgba(89, 240, 255, 0.95)', edge: 'rgba(255, 255, 255, 0.5)', glow: 'rgba(89, 240, 255, 0.32)' }
        : { core: 'rgba(255, 111, 142, 0.95)', edge: 'rgba(255, 255, 255, 0.5)', glow: 'rgba(255, 111, 142, 0.32)' };
    }

    if (this.category === 'barrage') {
      return this.canBeDestroyed
        ? { core: 'rgba(255, 255, 255, 0.94)', edge: 'rgba(255, 255, 255, 0.62)', glow: 'rgba(255, 255, 255, 0.3)' }
        : { core: 'rgba(245, 245, 245, 0.94)', edge: 'rgba(255, 255, 255, 0.56)', glow: 'rgba(255, 255, 255, 0.26)' };
    }

    return this.category === 'player1'
      ? { core: 'rgba(89, 240, 255, 0.9)', edge: 'rgba(255, 255, 255, 0.34)', glow: 'rgba(89, 240, 255, 0.24)' }
      : { core: 'rgba(255, 111, 142, 0.9)', edge: 'rgba(255, 255, 255, 0.34)', glow: 'rgba(255, 111, 142, 0.24)' };
  }

  private drawProjectile(ctx: CanvasRenderingContext2D) {
    const bodyWidth = Math.max(2, this.width);
    const bodyHeight = Math.max(6, this.height);
    const halfW = bodyWidth / 2;
    const halfH = bodyHeight / 2;

    ctx.beginPath();
    ctx.moveTo(0, -halfH);
    ctx.lineTo(halfW * 0.78, -halfH * 0.2);
    ctx.lineTo(halfW * 0.44, halfH * 0.48);
    ctx.lineTo(-halfW * 0.44, halfH * 0.48);
    ctx.lineTo(-halfW * 0.78, -halfH * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.beginPath();
    ctx.moveTo(0, -halfH * 0.72);
    ctx.lineTo(halfW * 0.18, 0);
    ctx.lineTo(0, halfH * 0.44);
    ctx.lineTo(-halfW * 0.18, 0);
    ctx.closePath();
    ctx.fill();
  }

  private drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, fill: boolean) {
    const halfW = width / 2;
    const halfH = height / 2;
    ctx.beginPath();
    ctx.moveTo(x + halfW, y);
    ctx.lineTo(x + width, y + halfH);
    ctx.lineTo(x + halfW, y + height);
    ctx.lineTo(x, y + halfH);
    ctx.closePath();
    if (fill) {
      ctx.fill();
    } else {
      ctx.stroke();
    }
  }
}