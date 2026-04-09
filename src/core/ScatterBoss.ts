import { Boss } from './Boss';
import { Bullet } from './Bullet';
import { Game } from './Game';
import { PlayerSide } from '../entities/types';

export class ScatterBoss extends Boss {
  private scatterPhase: 1 | 2 = 1;
  private phase1BurstTimer = 0;
  private phase1BulletsFired = 0;
  private phase1ToggleCounter = 0;
  private phase1CanBeDestroyed = true;
  private phase1BaseAngleDeg = (Math.random() - 0.5) * 12;
  private readonly phase1BurstInterval = 120; // ms between bursts in phase 1
  private readonly phase1BurstSize = 8;
  private readonly phase1MaxBullets = 160;
  private readonly phase1SpreadDeg = 120;
  private readonly phase1BaseSpeed = 4;

  private phase2BurstTimer = 0;
  private phase2BurstsFired = 0;
  private phase2CooldownTimer = 0;
  private readonly phase2BurstInterval = 300; // ms between legacy scatter calls in phase 2
  private readonly phase2BurstCount = 7;

  constructor(x: number, y: number, side: PlayerSide) {
    super(x, y, side, 125);
  }

  protected override onUpdate(deltaTime: number, game: Game): void {
    if (this.scatterPhase === 1) {
      if (this.phase1BulletsFired === 0 && this.phase1BurstTimer === 0) {
        this.firePhase1Burst(game);
        return;
      }

      this.phase1BurstTimer += deltaTime;
      while (this.phase1BurstTimer >= this.phase1BurstInterval && this.phase1BulletsFired < this.phase1MaxBullets) {
        this.phase1BurstTimer -= this.phase1BurstInterval;
        this.firePhase1Burst(game);
      }

      if (this.phase1BulletsFired >= this.phase1MaxBullets) {
        this.enterPhase2();
      }

      return;
    }

    // phase 2: retain the legacy scatter rhythm as a fallback pattern
    if (this.scatterPhase === 2) {
      this.phase2BurstTimer += deltaTime;

      if (this.phase2BurstsFired < this.phase2BurstCount) {
        if (this.phase2BurstTimer >= this.phase2BurstInterval) {
          this.phase2BurstTimer -= this.phase2BurstInterval;
          this.shootScatterLegacy(game);
          this.phase2BurstsFired++;
        }
        return;
      }

      this.phase2CooldownTimer += deltaTime;
      if (this.phase2CooldownTimer >= 1000) {
        this.resetToPhase1();
      }
    }
  }

  private firePhase1Burst(game: Game) {
    const startX = this.x + this.width / 2;
    const startY = this.y + this.height;
    const halfSpread = this.phase1SpreadDeg / 2;
    const baseAngleDeg = this.phase1BaseAngleDeg;

    for (let i = 0; i < this.phase1BurstSize; i++) {
      const progress = i / (this.phase1BurstSize - 1);
      const spreadAngleDeg = baseAngleDeg - halfSpread + progress * this.phase1SpreadDeg;
      const angleDeg = spreadAngleDeg;
      const angleRad = (angleDeg * Math.PI) / 180;
      const vx = Math.sin(angleRad) * this.phase1BaseSpeed;
      const vy = Math.cos(angleRad) * this.phase1BaseSpeed;

      const bullet = new Bullet(
        startX,
        startY,
        vx,
        vy,
        'barrage',
        'normal',
        this.phase1CanBeDestroyed,
        4,
        10,
        10,
        this.side
      );

      game.addBullet(bullet);
    }

    this.phase1BulletsFired += this.phase1BurstSize;
    this.phase1ToggleCounter += this.phase1BurstSize;

    if (this.phase1ToggleCounter >= 80) {
      this.phase1CanBeDestroyed = !this.phase1CanBeDestroyed;
      this.phase1ToggleCounter = 0;
    }

    // logging disabled: phase1 burst
    // keep `phase1BaseAngleDeg` constant during the phase (randomized on phase start)
  }

  private enterPhase2() {
    this.scatterPhase = 2;
    this.phase2BurstTimer = 0;
    this.phase2BurstsFired = 0;
    this.phase2CooldownTimer = 0;
  }

  private shootScatterLegacy(game: Game) {
    for (let i = -2; i <= 2; i++) {
      const bullet = new Bullet(
        this.x + this.width / 2,
        this.y + this.height,
        i * 1.5,
        4,
        'barrage',
        'normal',
        true,
        4,
        10,
        10,
        this.side
      );
      game.addBullet(bullet);
      const bullet2 = new Bullet(
        this.x + this.width / 2,
        this.y + this.height,
        i * 1.5/4*5,
        5,
        'barrage',
        'normal',
        true,
        4,
        10,
        10,
        this.side
      );
      game.addBullet(bullet2);
      const bullet3 = new Bullet(
        this.x + this.width / 2,
        this.y + this.height,
        i * 1.5/4*5.5,
        5.5,
        'barrage',
        'normal',
        true,
        4,
        10,
        10,
        this.side
      );
      game.addBullet(bullet3);
      // logging disabled: legacy scatter shot
    }
  }

  private resetToPhase1() {
    this.scatterPhase = 1;
    this.phase1BurstTimer = 0;
    this.phase1BulletsFired = 0;
    this.phase1ToggleCounter = 0;
    this.phase1CanBeDestroyed = true;
    this.phase1BaseAngleDeg = (Math.random() - 0.5) * 12;
    this.phase2BurstTimer = 0;
    this.phase2BurstsFired = 0;
    this.phase2CooldownTimer = 0;
  }
}
