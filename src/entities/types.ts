export type PlayerSide = 'left' | 'right';

export type AircraftType = 'scatter' | 'laser' | 'tracking';

export type Difficulty = 'easy' | 'normal' | 'hard';

export type GameMode = 'single' | 'dual' | 'selfplay';

export interface GameConfig {
  mode: GameMode;
  difficulty: Difficulty;
  player1Aircraft: AircraftType;
  player2Aircraft?: AircraftType;
}

export interface Position {
  x: number;
  y: number;
}

export interface Velocity {
  vx: number;
  vy: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 子弹大类
export type BulletCategory = 'player1' | 'player2' | 'barrage';

// 子弹类型（玩家子弹用：普通/特殊）
export type BulletType = 'normal' | 'special';
