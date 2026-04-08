import { Game } from '../core/Game';
import { Boss } from '../core/Boss';
import { Bullet } from '../core/Bullet';
import { Enemy } from '../core/Enemy';
import { Player } from '../core/Player';
import { Difficulty, PlayerSide } from '../entities/types';
import { SkillId, SkillScheduler } from './SkillScheduler';

interface Vector2 {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AIProfile {
  decisionInterval: number;
  lookAheadFrames: number;
  laneSamples: number;
  threatPadding: number;
  threatWeight: number;
  attackWeight: number;
  moveWeight: number;
  edgeWeight: number;
  randomJitter: number;
  deadZone: number;
  tapHoldMs: number;
  postActionCooldownMs: number;
  releaseWindows: [number, number, number, number, number];
  pressureThresholds: [number, number, number, number];
  pressureThreatPenalty: number;
  panicThreatThreshold: number;
  lowHealthRatio: number;
  enemyLaneWidth: number;
  bossPressureBonus: number;
  opponentLowHealthBonus: number;
  bombThreatThreshold: number;
  bombNearbyThreshold: number;
  bossBombHealthThreshold: number;
  allowUnlimitedTopSkill: boolean;
  opportunisticBurstThreatMax: number;
  enemyBodyThreatWeight: number;
  enemyBodyLookAheadFrames: number;
  enemyBodySpeedEstimate: number;
}

interface MovementPlan {
  target: Vector2;
  threat: number;
  opportunity: number;
  pressureScore: number;
  score: number;
}

interface AIContext {
  currentCenter: Vector2;
  currentThreat: number;
  nearbyBulletCount: number;
  enemies: Enemy[];
  boss: Boss | null;
  opponentHealthRatio: number;
  selfHealthRatio: number;
  maxUsefulLevel: number;
}

export class AIController {
  private readonly game: Game;
  private readonly player: Player;
  private readonly side: PlayerSide;
  private readonly profile: AIProfile;
  private readonly skillScheduler = new SkillScheduler();

  private decisionAccumulator = 0;
  private charging = false;
  private chargeHoldMs = 0;
  private chargingTargetLevel = 0;
  private postActionCooldownMs = 0;
  public lastSkillMask: boolean[] = [];
  public lastSkillRequested: SkillId = 'none';
  public lastSkillExecuted: SkillId = 'none';

  // Backward-compatible UI hook used by Game HUD.
  getChargeIntent(): { isCharging: boolean; progress: number; skill: string } {
    const chargingSkill = this.chargingTargetLevel >= 1;
    const requiredHold = chargingSkill
      ? this.profile.releaseWindows[Math.max(1, Math.min(4, this.chargingTargetLevel))]
      : 1;
    const progress = chargingSkill
      ? this.clamp(this.chargeHoldMs / Math.max(1, requiredHold), 0, 1)
      : 0;
    return {
      isCharging: chargingSkill,
      progress,
      skill: chargingSkill ? (`skill${this.chargingTargetLevel}`) : this.lastSkillRequested,
    };
  }

  constructor(game: Game, player: Player, side: PlayerSide, difficulty: Difficulty) {
    this.game = game;
    this.player = player;
    this.side = side;
    this.profile = this.getProfile(difficulty);
  }

  update(deltaTime: number) {
    this.decisionAccumulator += deltaTime;

    if (this.postActionCooldownMs > 0) {
      this.postActionCooldownMs = Math.max(0, this.postActionCooldownMs - deltaTime);
    }

    if (this.charging) {
      this.chargeHoldMs += deltaTime;
    }

    while (this.decisionAccumulator >= this.profile.decisionInterval) {
      this.decisionAccumulator -= this.profile.decisionInterval;
      this.makeDecision();
    }
  }

  private makeDecision() {
    const context = this.buildContext();
    const movementPlan = this.chooseMovementPlan(context);

    // build current skill availability mask for trainer / policy
    if (this.player && typeof this.player.getAvailableSkills === 'function') {
      const avail = this.player.getAvailableSkills();
      this.lastSkillMask = [avail.skill1, avail.skill2, avail.skill3, avail.skill4, avail.bomb];
      // console.debug('[AI] skillMask', this.lastSkillMask);
    }

    const skillRequested = this.selectSkillRequest(context, movementPlan);
    this.lastSkillRequested = skillRequested;
    const skillExecuted = this.executeRequestedSkill(skillRequested);
    this.lastSkillExecuted = skillExecuted;
    if (skillExecuted !== 'none') {
      this.postActionCooldownMs = Math.max(this.postActionCooldownMs, this.profile.postActionCooldownMs);
    }

    // Record a lightweight training event for this decision tick
    try {
      const enemySummaries = context.enemies.slice(0, 6).map(e => ({ x: e.x, y: e.y, width: e.width, height: e.height, health: e.health }));
      this.game.pushTrainingEvent({
        ts: Date.now(),
        side: this.side,
        playerCenter: this.getPlayerCenter(),
        movementTarget: movementPlan.target,
        movementScore: movementPlan.score,
        threat: context.currentThreat,
        nearbyBulletCount: context.nearbyBulletCount,
        enemies: enemySummaries,
        skillMask: this.lastSkillMask,
        skillRequested,
        skillExecuted,
      });
    } catch (e) {
      // swallow to avoid impacting game loop
    }

    this.applyMovementPlan(movementPlan);
  }

  private selectSkillRequest(context: AIContext, plan: MovementPlan): SkillId {
    const avail = this.player.getAvailableSkills();
    const boss = context.boss;
    const panicThreat = Math.max(context.currentThreat, plan.threat);

    if (avail.bomb) {
      const bossOnMySide = boss?.side === this.side;
      const bossOnOpponentSide = Boolean(boss && boss.side !== this.side);

      if (bossOnMySide && (panicThreat >= this.profile.bombThreatThreshold || context.selfHealthRatio <= this.profile.lowHealthRatio)) {
        return 'bomb';
      }

      if (bossOnOpponentSide && boss && boss.health <= this.profile.bossBombHealthThreshold) {
        return 'bomb';
      }

      if (context.nearbyBulletCount >= this.profile.bombNearbyThreshold && panicThreat >= this.profile.bombThreatThreshold) {
        return 'bomb';
      }
    }

    const maxUsefulLevel = context.maxUsefulLevel;
    const desiredLevel = this.getDesiredSkillLevel(context, plan, maxUsefulLevel);

    if (desiredLevel >= 4 && avail.skill4) return 'skill4';
    if (desiredLevel >= 3 && avail.skill3) return 'skill3';
    if (desiredLevel >= 2 && avail.skill2) return 'skill2';

    // Avoid spamming level-1 by requiring an actual attack window.
    if (desiredLevel >= 1 && avail.skill1 && plan.opportunity >= 1.15 && plan.threat <= this.profile.opportunisticBurstThreatMax) {
      return 'skill1';
    }

    return 'none';
  }

  private executeRequestedSkill(skillRequested: SkillId): SkillId {
    if (skillRequested === 'bomb') {
      this.resetChargeChain();
      return this.skillScheduler.triggerSkill('bomb', this.player, this.game);
    }

    if (skillRequested === 'skill1') {
      return this.runChargeChainForLevel(1);
    }

    if (skillRequested === 'skill2' || skillRequested === 'skill3' || skillRequested === 'skill4') {
      const targetLevel = Number(skillRequested.replace('skill', ''));
      return this.runChargeChainForLevel(targetLevel as 1 | 2 | 3 | 4);
    }

    // If no request while charging, continue existing chain until release.
    if (this.charging && this.chargingTargetLevel >= 1) {
      return this.runChargeChainForLevel(this.chargingTargetLevel as 1 | 2 | 3 | 4);
    }

    return 'none';
  }

  private runChargeChainForLevel(targetLevel: 1 | 2 | 3 | 4): SkillId {
    if (!this.charging || this.chargingTargetLevel !== targetLevel) {
      if (this.postActionCooldownMs > 0) {
        return 'none';
      }
      this.player.startCharging(this.game);
      this.charging = true;
      this.chargeHoldMs = 0;
      this.chargingTargetLevel = targetLevel;
      return 'none';
    }

    const chargeLevel = this.player.getChargeSystem().getLevel();
    const requiredHoldMs = this.profile.releaseWindows[Math.max(1, Math.min(4, targetLevel))];
    if (chargeLevel >= targetLevel && this.chargeHoldMs >= requiredHoldMs) {
      const executed = this.player.releaseCharge(this.game) as SkillId;
      this.resetChargeChain();
      return executed;
    }

    return 'none';
  }

  private resetChargeChain() {
    this.charging = false;
    this.chargeHoldMs = 0;
    this.chargingTargetLevel = 0;
  }

  private buildContext(): AIContext {
    const currentCenter = this.getPlayerCenter();
    const enemies = this.game
      .getEnemies(this.side)
      .filter((enemy) => enemy.active);
    const boss = this.game.getBoss();

    const bullets = this.getDangerousBullets();
    const currentThreat = this.computeThreatScore(currentCenter, bullets, enemies);
    const nearbyBulletCount = bullets.filter((bullet) => this.distance(this.getBulletCenter(bullet), currentCenter) < 120).length;

    const opponentSide = this.getOpponentSide();
    const opponentPlayer = this.game.getPlayer(opponentSide);

    const chargeSystem = this.player.getChargeSystem();
    const maxUsefulLevel = this.getMaxUsefulLevel(chargeSystem.getChargeMax());

    return {
      currentCenter,
      currentThreat,
      nearbyBulletCount,
      enemies,
      boss,
      opponentHealthRatio: opponentPlayer ? opponentPlayer.health / 100 : 1,
      selfHealthRatio: this.player.health / 100,
      maxUsefulLevel,
    };
  }

  private chooseMovementPlan(context: AIContext): MovementPlan {
    const bullets = this.getDangerousBullets();
    const screenHeight = this.game.getScreenHeight();
    const sideBounds = this.getSideBounds();
    const currentCenter = context.currentCenter;

    const targetY = this.clamp(
      screenHeight * (0.66 + Math.min(context.currentThreat, 5) * 0.03),
      sideBounds.minY,
      sideBounds.maxY,
    );

    const candidateXs = this.buildCandidateXs(currentCenter.x, context.enemies, sideBounds);
    const candidateYs = this.buildCandidateYs(currentCenter.y, targetY, sideBounds, context.currentThreat);

    let bestPlan: MovementPlan | null = null;

    for (const candidateX of candidateXs) {
      for (const candidateY of candidateYs) {
        const candidate = { x: candidateX, y: candidateY };
        const threat = this.computeThreatScore(candidate, bullets, context.enemies);
        const opportunity = this.computeOpportunityScore(candidateX, context.enemies, context.boss, context.opponentHealthRatio);
        const distanceCost = this.distance(currentCenter, candidate);
        const edgePenalty = this.computeEdgePenalty(candidateX, sideBounds);
        const yPenalty = Math.abs(candidateY - targetY) / 48;

        const score = (threat * this.profile.threatWeight)
          - (opportunity * this.profile.attackWeight)
          + (distanceCost * this.profile.moveWeight)
          + (edgePenalty * this.profile.edgeWeight)
          + (yPenalty * 0.25)
          + (Math.random() * this.profile.randomJitter);

        const pressureScore = opportunity
          - (threat * this.profile.pressureThreatPenalty)
          - (distanceCost / 250);

        if (!bestPlan || score < bestPlan.score) {
          bestPlan = {
            target: candidate,
            threat,
            opportunity,
            pressureScore,
            score,
          };
        }
      }
    }

    return bestPlan ?? {
      target: currentCenter,
      threat: context.currentThreat,
      opportunity: 0,
      pressureScore: 0,
      score: Number.POSITIVE_INFINITY,
    };
  }

  private applyMovementPlan(plan: MovementPlan) {
    const center = this.getPlayerCenter();
    const dx = plan.target.x - center.x;
    const dy = plan.target.y - center.y;

    this.player.movingLeft = dx < -this.profile.deadZone;
    this.player.movingRight = dx > this.profile.deadZone;
    this.player.movingUp = dy < -this.profile.deadZone;
    this.player.movingDown = dy > this.profile.deadZone;

    if (Math.abs(dx) <= this.profile.deadZone) {
      this.player.movingLeft = false;
      this.player.movingRight = false;
    }

    if (Math.abs(dy) <= this.profile.deadZone) {
      this.player.movingUp = false;
      this.player.movingDown = false;
    }
  }

  private buildCandidateXs(currentX: number, enemies: Enemy[], bounds: { minX: number; maxX: number }): number[] {
    const width = bounds.maxX - bounds.minX;
    const positions = new Set<number>();

    positions.add(this.clamp(currentX, bounds.minX, bounds.maxX));
    positions.add(this.clamp(bounds.minX + width * 0.18, bounds.minX, bounds.maxX));
    positions.add(this.clamp(bounds.minX + width * 0.5, bounds.minX, bounds.maxX));
    positions.add(this.clamp(bounds.minX + width * 0.82, bounds.minX, bounds.maxX));

    const clusterX = this.computeEnemyClusterX(enemies, bounds);
    positions.add(clusterX);

    for (let index = 0; index < this.profile.laneSamples; index++) {
      const lane = bounds.minX + width * ((index + 0.5) / this.profile.laneSamples);
      positions.add(this.clamp(lane, bounds.minX, bounds.maxX));
    }

    return Array.from(positions);
  }

  private buildCandidateYs(currentY: number, targetY: number, bounds: { minY: number; maxY: number }, threat: number): number[] {
    const panicY = this.clamp(bounds.maxY, bounds.minY, bounds.maxY);
    const safeY = this.clamp(bounds.minY + (bounds.maxY - bounds.minY) * 0.88, bounds.minY, bounds.maxY);
    const attackY = this.clamp(bounds.minY + (bounds.maxY - bounds.minY) * 0.62, bounds.minY, bounds.maxY);
    const extraOffset = this.clamp(targetY + Math.min(24, threat * 5), bounds.minY, bounds.maxY);

    return Array.from(new Set([
      this.clamp(currentY, bounds.minY, bounds.maxY),
      targetY,
      attackY,
      safeY,
      panicY,
      extraOffset,
    ]));
  }

  private computeEnemyClusterX(enemies: Enemy[], bounds: { minX: number; maxX: number }): number {
    if (enemies.length === 0) {
      return (bounds.minX + bounds.maxX) / 2;
    }

    let weightedX = 0;
    let totalWeight = 0;

    for (const enemy of enemies) {
      const centerX = enemy.x + enemy.width / 2;
      const weight = 1 + Math.max(0, enemy.y) / this.game.getScreenHeight();
      weightedX += centerX * weight;
      totalWeight += weight;
    }

    if (totalWeight <= 0) {
      return (bounds.minX + bounds.maxX) / 2;
    }

    return this.clamp(weightedX / totalWeight, bounds.minX, bounds.maxX);
  }

  private computeOpportunityScore(candidateX: number, enemies: Enemy[], boss: Boss | null, opponentHealthRatio: number): number {
    let opportunity = 0;
    const laneWidth = this.profile.enemyLaneWidth;

    for (const enemy of enemies) {
      const centerX = enemy.x + enemy.width / 2;
      const distance = Math.abs(centerX - candidateX);

      if (distance > laneWidth) {
        continue;
      }

      const laneScore = 1 - (distance / laneWidth);
      const heightWeight = 1 + Math.max(0, enemy.y) / (this.game.getScreenHeight() * 0.8);
      opportunity += laneScore * heightWeight;
    }

    if (boss && boss.side !== this.side) {
      opportunity += this.profile.bossPressureBonus;
    }

    if (opponentHealthRatio <= 0.35) {
      opportunity += this.profile.opponentLowHealthBonus;
    }

    return opportunity;
  }

  private computeThreatScore(center: Vector2, bullets: Bullet[], enemies: Enemy[]): number {
    const playerRect = this.getInflatedRect(center, this.profile.threatPadding);
    let threat = 0;

    for (const bullet of bullets) {
      threat += this.computeBulletThreat(bullet, playerRect);
    }

    threat += this.computeEnemyBodyThreat(center, enemies);

    return threat;
  }

  private computeEnemyBodyThreat(center: Vector2, enemies: Enemy[]): number {
    const lookAhead = this.profile.enemyBodyLookAheadFrames;
    const playerRect = this.getInflatedRect(center, this.profile.threatPadding + 10);
    let threat = 0;

    for (const enemy of enemies) {
      let localThreat = 0;

      for (let frame = 0; frame <= lookAhead; frame++) {
        const projectedY = enemy.y + this.profile.enemyBodySpeedEstimate * frame;
        const enemyRect = {
          x: enemy.x,
          y: projectedY,
          width: enemy.width,
          height: enemy.height,
        };

        if (this.rectsOverlap(enemyRect, playerRect)) {
          localThreat = Math.max(localThreat, 1.4 + ((lookAhead - frame + 1) / lookAhead));
          break;
        }

        const horizontalGap = Math.max(
          playerRect.x - (enemyRect.x + enemyRect.width),
          enemyRect.x - (playerRect.x + playerRect.width),
          0,
        );
        const verticalGap = Math.max(
          playerRect.y - (enemyRect.y + enemyRect.height),
          enemyRect.y - (playerRect.y + playerRect.height),
          0,
        );

        const distance = Math.hypot(horizontalGap, verticalGap);
        if (distance < 90) {
          localThreat = Math.max(localThreat, (90 - distance) / 90 * 0.85);
        }
      }

      threat += localThreat * this.profile.enemyBodyThreatWeight;
    }

    return threat;
  }

  private computeBulletThreat(bullet: Bullet, playerRect: Rect): number {
    const lookAheadFrames = this.profile.lookAheadFrames;
    let softThreat = 0;
    const projector = (bullet as any).getProjectedThreatRect;

    for (let frame = 1; frame <= lookAheadFrames; frame++) {
      const bulletRect = typeof projector === 'function'
        ? projector.call(bullet, frame, 1000 / 60)
        : {
            x: bullet.x + bullet.vx * frame,
            y: bullet.y + bullet.vy * frame,
            width: bullet.width,
            height: bullet.height,
          };

      if (this.rectsOverlap(bulletRect, playerRect)) {
        return 1 + ((lookAheadFrames - frame + 1) / lookAheadFrames);
      }

      const horizontalGap = Math.max(
        playerRect.x - (bulletRect.x + bulletRect.width),
        bulletRect.x - (playerRect.x + playerRect.width),
        0,
      );
      const verticalGap = Math.max(
        playerRect.y - (bulletRect.y + bulletRect.height),
        bulletRect.y - (playerRect.y + playerRect.height),
        0,
      );

      const distance = Math.hypot(horizontalGap, verticalGap);
      if (distance < 50) {
        softThreat = Math.max(softThreat, (50 - distance) / 50 * 0.45);
      }
    }

    return softThreat;
  }

  private getDangerousBullets(): Bullet[] {
    return this.game
      .getBullets(this.side)
      .filter((bullet) => bullet.category === 'barrage');
  }

  private getMaxUsefulLevel(chargeMax: number): number {
    // New gauge design: top-level release can be achieved via hold-charge in hard mode.
    if (this.profile.allowUnlimitedTopSkill) return 4;
    if (chargeMax >= 80) return 4;
    if (chargeMax >= 60) return 3;
    if (chargeMax >= 40) return 2;
    if (chargeMax >= 20) return 1;
    return 0;
  }

  private getDesiredSkillLevel(context: AIContext, plan: MovementPlan, maxUsefulLevel: number): number {
    if (maxUsefulLevel <= 0) {
      return 0;
    }

    if (context.selfHealthRatio <= this.profile.lowHealthRatio || context.currentThreat >= this.profile.panicThreatThreshold) {
      return Math.min(1, maxUsefulLevel);
    }

    let pressure = plan.pressureScore;

    if (context.boss && context.boss.side !== this.side) {
      pressure += this.profile.bossPressureBonus;
    }

    if (context.opponentHealthRatio <= 0.35) {
      pressure += this.profile.opponentLowHealthBonus;
    }

    if (pressure >= this.profile.pressureThresholds[3]) {
      return Math.min(4, maxUsefulLevel);
    }

    if (pressure >= this.profile.pressureThresholds[2]) {
      return Math.min(3, maxUsefulLevel);
    }

    if (pressure >= this.profile.pressureThresholds[1]) {
      return Math.min(2, maxUsefulLevel);
    }

    if (pressure >= this.profile.pressureThresholds[0]) {
      return Math.min(1, maxUsefulLevel);
    }

    // With unlimited top-level release enabled, keep charging for level 4 under mild pressure.
    if (this.profile.allowUnlimitedTopSkill && pressure > 0.35 && context.currentThreat < this.profile.panicThreatThreshold) {
      return 4;
    }

    return 0;
  }

  private getProfile(difficulty: Difficulty): AIProfile {
    switch (difficulty) {
      case 'easy':
        return {
          decisionInterval: 180,
          lookAheadFrames: 16,
          laneSamples: 5,
          threatPadding: 22,
          threatWeight: 1.95,
          attackWeight: 0.78,
          moveWeight: 0.011,
          edgeWeight: 0.32,
          randomJitter: 0.3,
          deadZone: 12,
          tapHoldMs: 150,
          postActionCooldownMs: 150,
          releaseWindows: [150, 520, 940, 1380, 1760],
          pressureThresholds: [0.8, 2.1, 3.6, 5.2],
          pressureThreatPenalty: 0.6,
          panicThreatThreshold: 2.5,
          lowHealthRatio: 0.35,
          enemyLaneWidth: 92,
          bossPressureBonus: 1.05,
          opponentLowHealthBonus: 0.8,
          bombThreatThreshold: 2.3,
          bombNearbyThreshold: 7,
          bossBombHealthThreshold: 260,
          allowUnlimitedTopSkill: false,
          opportunisticBurstThreatMax: 0.9,
          enemyBodyThreatWeight: 0.75,
          enemyBodyLookAheadFrames: 20,
          enemyBodySpeedEstimate: 3.75,
        };
      case 'hard':
        return {
          decisionInterval: 48,
          lookAheadFrames: 46,
          laneSamples: 10,
          threatPadding: 11,
          threatWeight: 3.45,
          attackWeight: 1.75,
          moveWeight: 0.006,
          edgeWeight: 0.18,
          randomJitter: 0.03,
          deadZone: 4,
          tapHoldMs: 80,
          postActionCooldownMs: 35,
          releaseWindows: [80, 260, 520, 790, 1050],
          pressureThresholds: [0.2, 0.95, 1.8, 2.7],
          pressureThreatPenalty: 0.3,
          panicThreatThreshold: 3.8,
          lowHealthRatio: 0.18,
          enemyLaneWidth: 70,
          bossPressureBonus: 2.1,
          opponentLowHealthBonus: 1.8,
          bombThreatThreshold: 3.0,
          bombNearbyThreshold: 4,
          bossBombHealthThreshold: 380,
          allowUnlimitedTopSkill: true,
          opportunisticBurstThreatMax: 0.75,
          enemyBodyThreatWeight: 1.3,
          enemyBodyLookAheadFrames: 34,
          enemyBodySpeedEstimate: 3.75,
        };
      case 'normal':
      default:
        return {
          decisionInterval: 120,
          lookAheadFrames: 24,
          laneSamples: 6,
          threatPadding: 18,
          threatWeight: 2.35,
          attackWeight: 1.08,
          moveWeight: 0.01,
          edgeWeight: 0.28,
          randomJitter: 0.15,
          deadZone: 9,
          tapHoldMs: 120,
          postActionCooldownMs: 90,
          releaseWindows: [120, 430, 820, 1240, 1600],
          pressureThresholds: [0.6, 1.85, 3.05, 4.55],
          pressureThreatPenalty: 0.48,
          panicThreatThreshold: 2.9,
          lowHealthRatio: 0.28,
          enemyLaneWidth: 84,
          bossPressureBonus: 1.35,
          opponentLowHealthBonus: 1.1,
          bombThreatThreshold: 2.8,
          bombNearbyThreshold: 6,
          bossBombHealthThreshold: 300,
          allowUnlimitedTopSkill: false,
          opportunisticBurstThreatMax: 0.85,
          enemyBodyThreatWeight: 1,
          enemyBodyLookAheadFrames: 26,
          enemyBodySpeedEstimate: 3.75,
        };
    }
  }

  private getOpponentSide(): PlayerSide {
    return this.side === 'left' ? 'right' : 'left';
  }

  private getPlayerCenter(): Vector2 {
    return {
      x: this.player.x + this.player.width / 2,
      y: this.player.y + this.player.height / 2,
    };
  }

  private getBulletCenter(bullet: Bullet): Vector2 {
    return {
      x: bullet.x + bullet.width / 2,
      y: bullet.y + bullet.height / 2,
    };
  }

  private getInflatedRect(center: Vector2, padding: number): Rect {
    return {
      x: center.x - this.player.width / 2 - padding,
      y: center.y - this.player.height / 2 - padding,
      width: this.player.width + padding * 2,
      height: this.player.height + padding * 2,
    };
  }

  private getSideBounds() {
    const screenWidth = this.game.getScreenWidth();
    const screenHeight = this.game.getScreenHeight();
    const margin = this.game.getMargin();
    const halfWidth = screenWidth * 0.5;
    const marginWidth = screenWidth * margin / 2;
    const halfPlayerWidth = this.player.width / 2;
    const halfPlayerHeight = this.player.height / 2;

    if (this.side === 'left') {
      return {
        minX: halfPlayerWidth,
        maxX: halfWidth - marginWidth - halfPlayerWidth,
        minY: screenHeight * 0.4 + halfPlayerHeight,
        maxY: screenHeight - halfPlayerHeight,
      };
    }

    return {
      minX: halfWidth + marginWidth + halfPlayerWidth,
      maxX: screenWidth - halfPlayerWidth,
      minY: screenHeight * 0.4 + halfPlayerHeight,
      maxY: screenHeight - halfPlayerHeight,
    };
  }

  private computeEdgePenalty(candidateX: number, bounds: { minX: number; maxX: number }): number {
    const edgeBuffer = 32;
    const leftGap = candidateX - bounds.minX;
    const rightGap = bounds.maxX - candidateX;
    const nearEdge = Math.min(leftGap, rightGap);

    if (nearEdge >= edgeBuffer) {
      return 0;
    }

    return (edgeBuffer - nearEdge) / edgeBuffer;
  }

  private rectsOverlap(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width
      && a.x + a.width > b.x
      && a.y < b.y + b.height
      && a.y + a.height > b.y;
  }

  private distance(a: Vector2, b: Vector2): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
