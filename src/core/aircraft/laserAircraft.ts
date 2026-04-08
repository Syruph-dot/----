import { Bullet } from '../Bullet';
import { AircraftProfile, SkillContext } from './types';

const triggerLaserBoss = (side: 'left' | 'right', intensity: 2 | 3 | 4, game: SkillContext['game']) => {
  const targetSide = side === 'left' ? 'right' : 'left';
  game.triggerBoss(targetSide, 'laser');
  const boss = game.getBoss();
  const skillBoss = boss as unknown as { setSkillIntensity?: (level: 2 | 3 | 4) => void } | null;
  if (skillBoss?.setSkillIntensity) {
    skillBoss.setSkillIntensity(intensity);
  }
};

export const laserAircraftProfile: AircraftProfile = {
  type: 'laser',
  getPalette(side) {
    return side === 'left'
      ? { stroke: '#9cff6e', glow: 'rgba(156, 255, 110, 0.34)', fill: 'rgba(10, 18, 30, 0.96)' }
      : { stroke: '#ffd166', glow: 'rgba(255, 209, 102, 0.34)', fill: 'rgba(10, 18, 30, 0.96)' };
  },
  useLevel1Skill({ player, addBullet }) {
    const category = player.getSide() === 'left' ? 'player1' : 'player2';
    const laser = new Bullet(
      player.x + player.width / 2,
      player.y,
      0,
      0,
      category,
      'special',
      false,
      10,
      10,
      10,
      player.getSide()
    );
    if ((laser as { startLaser?: (owner: unknown, durationMs: number, cooldownMs: number, damage: number) => void }).startLaser) {
      (laser as { startLaser: (owner: unknown, durationMs: number, cooldownMs: number, damage: number) => void }).startLaser(player, 1500, 400, 10);
    }
    addBullet(laser);
  },
  handleLevel2Skill({ player, game }) {
    triggerLaserBoss(player.getSide(), 2, game);
    return true;
  },
  handleLevel3Skill({ player, game }) {
    triggerLaserBoss(player.getSide(), 3, game);
    return true;
  },
  handleLevel4Skill({ player, game }) {
    triggerLaserBoss(player.getSide(), 4, game);
    return true;
  },
};
