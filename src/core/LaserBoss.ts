import { Boss } from './Boss';
import { Bullet } from './Bullet';
import { Game } from './Game';
import { PlayerSide } from '../entities/types';
import { createBulletFromSpawnSpec } from './bullets/patternEmitter';

interface LaserEmitterState {
  bullet: Bullet;
  shootAngleDeg: number;
  lastShootTime: number;
}

export class LaserBoss extends Boss {
  // Configurable parameters (adjustable by skill intensity)
  private emitterSpawnInterval = 2000; // ms between emitter pairs
  private emitterShootInterval = 400; // ms between emitter bursts
  private emitterRotateStepDeg = 125; // deg step after each shot
  private emitterMoveSpeed = 2.4; // px per update step
  private emitterOutOfBoundsGrace = 300; // ms grace after leaving screen

  private laserSpeedPxPerSecond = 300;
  private laserLengthPx = 140;
  private laserThicknessPx = 8;
  private laserLifetimeMs = 2200;

  private lastEmitterSpawnTime = 0;
  private emitters: LaserEmitterState[] = [];

  constructor(x: number, y: number, side: PlayerSide) {
    super(x, y, side, 125);
  }

  // Configure boss behavior according to skill level (2/3/4)
  public setSkillIntensity(level: number) {
    if (level === 2) {
      this.emitterSpawnInterval = 2000;
      this.emitterShootInterval = 400;
      this.emitterMoveSpeed = 2.4;
      this.laserLifetimeMs = 2200;
    } else if (level === 3) {
      // Skill3: laser duration doubled relative to skill2
      this.emitterSpawnInterval = 2000;
      this.emitterShootInterval = 400;
      this.emitterMoveSpeed = 2.4;
      this.laserLifetimeMs = 2200 * 2;
    } else if (level === 4) {
      // Skill4: more aggressive emitter cadence
      this.emitterSpawnInterval = 1200;
      this.emitterShootInterval = 350;
      this.emitterMoveSpeed = 3.2;
      this.laserLifetimeMs = 2200;
    }
  }

  protected override onUpdate(_deltaTime: number, game: Game): void {
    const now = Date.now();

    this.emitters = this.emitters.filter((emitter) => emitter.bullet.active);

    if (this.lastEmitterSpawnTime === 0 || now - this.lastEmitterSpawnTime >= this.emitterSpawnInterval) {
      this.lastEmitterSpawnTime = now;
      this.spawnEmitterPair(game, now);
    }

    for (const emitter of this.emitters) {
      if (now - emitter.lastShootTime < this.emitterShootInterval) {
        continue;
      }

      emitter.lastShootTime = now;
      this.fireEmitterBurst(game, emitter);
    }
  }

  private spawnEmitterPair(game: Game, now: number) {
    const d = -10 + Math.random() * 20;
    const baseLeftDeg = -90 + d;

    this.spawnEmitter(game, baseLeftDeg, now);
    this.spawnEmitter(game, baseLeftDeg + 180, now);
  }

  private spawnEmitter(game: Game, angleDeg: number, now: number) {
    const emitterBullet = createBulletFromSpawnSpec({
      x: this.x + this.width / 2 - 5,
      y: this.y + this.height / 2 - 5,
      directionDeg: angleDeg,
      speed: this.emitterMoveSpeed,
      side: this.side,
      category: 'barrage',
      bulletType: 'special',
      canBeDestroyed: false,
      width: 8,
      height: 8,
      damage: 0,
    });

    emitterBullet.configureOutOfBoundsGracePeriod(this.emitterOutOfBoundsGrace);
    const tokenId = this.getSkillLifecycleId();
    if (typeof tokenId === 'number') {
      game.addSkillBullet(emitterBullet, tokenId);
    } else {
      game.addBullet(emitterBullet);
    }

    this.emitters.push({
      bullet: emitterBullet,
      shootAngleDeg: angleDeg,
      lastShootTime: now - this.emitterShootInterval,
    });
  }

  private fireEmitterBurst(game: Game, emitter: LaserEmitterState) {
    for (let i = 0; i < 3; i++) {
      this.fireMovingLaser(game, emitter.bullet, emitter.shootAngleDeg);
      emitter.shootAngleDeg = this.normalizeAngleDeg(emitter.shootAngleDeg + this.emitterRotateStepDeg);
    }
  }

  private fireMovingLaser(game: Game, emitterBullet: Bullet, angleDeg: number) {
    const originX = emitterBullet.x + emitterBullet.width / 2;
    const originY = emitterBullet.y + emitterBullet.height / 2;

    const laserBullet = new Bullet(
      originX,
      originY,
      0,
      0,
      'barrage',
      'special',
      false,
      this.laserThicknessPx,
      this.laserThicknessPx,
      10,
      this.side
    );

    // 使用可反弹段激光并传入该发射器所属半屏的边界
    const viewport = game.getSideViewport(emitterBullet.side);
    laserBullet.startBouncingSegmentLaser(
      angleDeg,
      this.laserSpeedPxPerSecond,
      this.laserLengthPx,
      {
        minX: viewport.x,
        maxX: viewport.x + viewport.width,
        minY: viewport.y,
        maxY: viewport.y + viewport.height,
      },
      this.laserThicknessPx,
      this.laserLifetimeMs
    );

    const tokenId = this.getSkillLifecycleId();
    if (typeof tokenId === 'number') {
      game.addSkillBullet(laserBullet, tokenId);
    } else {
      game.addBullet(laserBullet);
    }
  }

  private normalizeAngleDeg(angleDeg: number): number {
    let normalized = ((angleDeg % 360) + 360) % 360;
    if (normalized > 180) {
      normalized -= 360;
    }
    return normalized;
  }
}
