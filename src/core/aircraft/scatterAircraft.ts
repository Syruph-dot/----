import { Bullet } from '../Bullet';
import { AircraftProfile } from './types';

export const scatterAircraftProfile: AircraftProfile = {
  type: 'scatter',
  getPalette(side) {
    return side === 'left'
      ? { stroke: '#59f0ff', glow: 'rgba(89, 240, 255, 0.34)', fill: 'rgba(10, 18, 30, 0.96)' }
      : { stroke: '#ff6f8e', glow: 'rgba(255, 111, 142, 0.34)', fill: 'rgba(10, 18, 30, 0.96)' };
  },
  useLevel1Skill({ player, addBullet }) {
    const category = player.getSide() === 'left' ? 'player1' : 'player2';
    for (let i = -1; i <= 1; i++) {
      addBullet(new Bullet(
        player.x + player.width / 2,
        player.y,
        i * 2,
        -10,
        category,
        'special',
        false,
        50,
        50,
        10,
        player.getSide()
      ));
    }
  },
};
