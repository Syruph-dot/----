import { Boss } from './Boss';
import { Bullet } from './Bullet';
import { Game } from './Game';
import { PlayerSide } from '../entities/types';

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
    const bullet = new Bullet(
      this.x + this.width / 2,
      this.y + this.height,
      (Math.random() - 0.5) * 2,
      5,
      'barrage',
      'normal',
      true,
      4,
      10,
      10,
      this.side
    );
    game.addBullet(bullet);
  }
}
