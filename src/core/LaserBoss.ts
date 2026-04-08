import { Boss } from './Boss';
import { Bullet } from './Bullet';
import { Game } from './Game';
import { PlayerSide } from '../entities/types';

interface LaserEmitterState {
  bullet: Bullet;
  shootAngleDeg: number;
  lastShootTime: number;
}

export class LaserBoss extends Boss {
  private readonly emitterSpawnInterval = 2000;
  private readonly emitterShootInterval = 400;
  private readonly emitterRotateStepDeg = 125;
  private readonly emitterMoveSpeed = 2.4;
  private readonly emitterOutOfBoundsGrace = 300;

  private readonly laserSpeedPxPerSecond = 300;
  private readonly laserLengthPx = 140;
  private readonly laserThicknessPx = 8;
  private readonly laserLifetimeMs = 2200;

  private lastEmitterSpawnTime = 0;
  private emitters: LaserEmitterState[] = [];

  constructor(x: number, y: number, side: PlayerSide) {
    super(x, y, side, 125);
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
    const angleRad = (angleDeg * Math.PI) / 180;
    const vx = Math.sin(angleRad) * this.emitterMoveSpeed;
    const vy = Math.cos(angleRad) * this.emitterMoveSpeed;

    const emitterBullet = new Bullet(
      this.x + this.width / 2 - 5,
      this.y + this.height / 2 - 5,
      vx,
      vy,
      'barrage',
      'special',
      false,
      8,
      8,
      0,
      this.side
    );

    emitterBullet.configureOutOfBoundsGracePeriod(this.emitterOutOfBoundsGrace);
    game.addBullet(emitterBullet);

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

    laserBullet.startSegmentLaser(
      angleDeg,
      this.laserSpeedPxPerSecond,
      this.laserLengthPx,
      this.laserThicknessPx,
      this.laserLifetimeMs
    );

    game.addBullet(laserBullet);
  }

  private normalizeAngleDeg(angleDeg: number): number {
    let normalized = ((angleDeg % 360) + 360) % 360;
    if (normalized > 180) {
      normalized -= 360;
    }
    return normalized;
  }
}
