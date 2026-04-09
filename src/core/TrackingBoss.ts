import { Boss } from './Boss';
import { Game } from './Game';
import { PlayerSide } from '../entities/types';
import { emitPatternBullets } from './bullets/patternEmitter';

export class TrackingBoss extends Boss {
  private lastShootTime = 0;
  private readonly shootCooldown = 500;

  constructor(x: number, y: number, side: PlayerSide) {
    super(x, y, side, 125);
  }

  protected override onUpdate(_deltaTime: number, game: Game): void {
    const now = Date.now();
    if (now - this.lastShootTime > this.shootCooldown) {
      this.lastShootTime = now;
      this.shootTracking(game);
    }
  }

  private shootTracking(game: Game) {
    emitPatternBullets(
      {
        kind: 'single',
        directionDeg: Math.random() * 22 - 11,
        speed: 5,
      },
      {
        originX: this.x + this.width / 2,
        originY: this.y + this.height,
        side: this.side,
        category: 'barrage',
        bulletType: 'normal',
        canBeDestroyed: true,
        width: 4,
        height: 10,
        damage: 10,
      },
      (bullet) => game.addBullet(bullet)
    );
  }
}
