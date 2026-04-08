import { Bullet } from '../Bullet';
import { AircraftProfile } from './types';

export const trackingAircraftProfile: AircraftProfile = {
  type: 'tracking',
  getPalette(side) {
    return side === 'left'
      ? { stroke: '#ffd166', glow: 'rgba(255, 209, 102, 0.34)', fill: 'rgba(10, 18, 30, 0.96)' }
      : { stroke: '#b88cff', glow: 'rgba(184, 140, 255, 0.34)', fill: 'rgba(10, 18, 30, 0.96)' };
  },
  useLevel1Skill({ player, addBullet }) {
    const category = player.getSide() === 'left' ? 'player1' : 'player2';
    for (let i = 0; i < 3; i++) {
      addBullet(new Bullet(
        player.x + player.width / 2 + (i - 1) * 20,
        player.y,
        0,
        -8,
        category,
        'special',
        false,
        4,
        10,
        10,
        player.getSide()
      ));
    }
  },
};
