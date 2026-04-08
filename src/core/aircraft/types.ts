import { Bullet } from '../Bullet';
import { Game } from '../Game';
import type { Player } from '../Player';
import { AircraftType, PlayerSide } from '../../entities/types';

export type AircraftPalette = {
  stroke: string;
  glow: string;
  fill: string;
};

export type SkillContext = {
  player: Player;
  game: Game;
  skillTokenId?: number;
  addBullet: (bullet: Bullet) => void;
};

export interface AircraftProfile {
  readonly type: AircraftType;
  getPalette(side: PlayerSide): AircraftPalette;
  useLevel1Skill(context: SkillContext): void;
  handleLevel2Skill?(context: SkillContext): boolean;
  handleLevel3Skill?(context: SkillContext): boolean;
  handleLevel4Skill?(context: SkillContext): boolean;
}
