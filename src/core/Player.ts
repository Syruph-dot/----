import { Game } from './Game';
import { Bullet } from './Bullet';
import { ChargeSystem } from '../systems/ChargeSystem';
import { ComboSystem } from '../systems/ComboSystem';
import { PlayerSide, AircraftType } from '../entities/types';
import { getAircraftProfile } from './aircraft';
import { AircraftProfile } from './aircraft/types';

export class Player {
  x: number;
  y: number;
  // scale player to 66% of the original size
  width = 40 * 0.66;
  height = 40 * 0.66;
  speed = 5;
  private readonly normalSpeed = 5;
  private readonly focusSpeed = 2.2;
  health = 100;
  bombs = 2;
  
  movingLeft = false;
  movingRight = false;
  movingUp = false;
  movingDown = false;
  private focusEnabled = false;
  private focusMode = false;
  private readonly hitboxRadius = 4;
  
  private side: PlayerSide;
  private readonly aircraftProfile: AircraftProfile;
  private chargeSystem: ChargeSystem;
  private comboSystem: ComboSystem;
  
  private isCharging = false;
  private chargeStartTime = 0;
  private chargeKeyHeld = false;
  private chargeKeyDownTime = 0;
  private lastShootTime = 0;
  private readonly shootCooldown = 100;
  private readonly hurtDurationMs = 1000;
  private hurtElapsedMs = 1000;
  private knockbackBaseVx = 0;
  private knockbackBaseVy = 0;
  private lowHpGaugeBoostUsed = false;
  
  // rotation (degrees) and simple P-controller target
  private angle = 0; // current angle in degrees
  private targetAngle = 0; // desired angle in degrees
  private readonly rotationKP = 10; // proportional gain (deg/s per deg error)
  
  // SVG overlay elements (optional)
  private svgRoot?: SVGSVGElement;
  private svgGroup?: SVGGElement;
  private svgGlowPath?: SVGPathElement;
  private svgPath?: SVGPathElement;
  private svgHitboxRing?: SVGCircleElement;
  private svgHitboxCore?: SVGCircleElement;
  
  constructor(
    x: number,
    y: number,
    side: PlayerSide,
    chargeSystem: ChargeSystem,
    comboSystem: ComboSystem,
    aircraftType: AircraftType = 'scatter',
    svgRoot?: SVGSVGElement
  ) {
    this.x = x;
    this.y = y;
    this.side = side;
    this.chargeSystem = chargeSystem;
    this.comboSystem = comboSystem;
    this.aircraftProfile = getAircraftProfile(aircraftType);
    this.svgRoot = svgRoot;

    if (this.svgRoot) {
      const svgNS = 'http://www.w3.org/2000/svg';
      this.svgGroup = document.createElementNS(svgNS, 'g') as SVGGElement;
      this.svgGlowPath = document.createElementNS(svgNS, 'path') as SVGPathElement;
      this.svgPath = document.createElementNS(svgNS, 'path') as SVGPathElement;

      const w = this.width;
      const h = this.height;
      const d = `M 0 ${-h * 0.72} L ${w * 0.36} ${-h * 0.12} L ${w * 0.6} ${h * 0.26} L ${w * 0.18} ${h * 0.22} L ${w * 0.08} ${h * 0.58} L 0 ${h * 0.38} L ${-w * 0.08} ${h * 0.58} L ${-w * 0.18} ${h * 0.22} L ${-w * 0.6} ${h * 0.26} L ${-w * 0.36} ${-h * 0.12} Z`;

      this.svgGlowPath.setAttribute('d', d);
      this.svgGlowPath.setAttribute('fill', 'rgba(6, 10, 20, 0.72)');
      this.svgGlowPath.setAttribute('stroke', this.side === 'left' ? 'rgba(89, 240, 255, 0.3)' : 'rgba(255, 111, 142, 0.3)');
      this.svgGlowPath.setAttribute('stroke-width', String(Math.max(10, this.width / 2.2)));
      this.svgGlowPath.setAttribute('stroke-linejoin', 'round');
      this.svgGlowPath.setAttribute('stroke-linecap', 'round');

      this.svgPath.setAttribute('d', d);
      this.svgPath.setAttribute('fill', 'rgba(9, 16, 30, 0.96)');
      this.svgPath.setAttribute('stroke', this.side === 'left' ? '#59f0ff' : '#ff6f8e');
      const strokeW = Math.max(4, Math.min(8, this.width / 5));
      this.svgPath.setAttribute('stroke-width', String(strokeW));
      this.svgPath.setAttribute('stroke-linejoin', 'round');
      this.svgPath.setAttribute('stroke-linecap', 'round');

      this.svgHitboxRing = document.createElementNS(svgNS, 'circle') as SVGCircleElement;
      this.svgHitboxRing.setAttribute('r', String(this.hitboxRadius + 3));
      this.svgHitboxRing.setAttribute('fill', 'rgba(255, 255, 255, 0.04)');
      this.svgHitboxRing.setAttribute('stroke', this.side === 'left' ? 'rgba(89, 240, 255, 0.92)' : 'rgba(255, 111, 142, 0.92)');
      this.svgHitboxRing.setAttribute('stroke-width', '1.5');
      this.svgHitboxRing.setAttribute('opacity', '0');

      this.svgHitboxCore = document.createElementNS(svgNS, 'circle') as SVGCircleElement;
      this.svgHitboxCore.setAttribute('r', String(this.hitboxRadius));
      this.svgHitboxCore.setAttribute('fill', this.side === 'left' ? 'rgba(89, 240, 255, 0.95)' : 'rgba(255, 111, 142, 0.95)');
      this.svgHitboxCore.setAttribute('stroke', 'rgba(255, 255, 255, 0.82)');
      this.svgHitboxCore.setAttribute('stroke-width', '1');
      this.svgHitboxCore.setAttribute('opacity', '0');

      this.svgGroup.appendChild(this.svgGlowPath);
      this.svgGroup.appendChild(this.svgPath);
      this.svgGroup.appendChild(this.svgHitboxRing);
      this.svgGroup.appendChild(this.svgHitboxCore);
      this.svgRoot.appendChild(this.svgGroup);
    }
  }
  
  update(deltaTime: number, game: Game) {
    this.speed = this.focusEnabled && this.focusMode ? this.focusSpeed : this.normalSpeed;
    const controlLocked = this.isInHurtState();

    if (!controlLocked) {
      if (this.movingLeft) this.x -= this.speed;
      if (this.movingRight) this.x += this.speed;
      if (this.movingUp) this.y -= this.speed;
      if (this.movingDown) this.y += this.speed;
    }

    if (controlLocked) {
      this.hurtElapsedMs = Math.min(this.hurtDurationMs, this.hurtElapsedMs + deltaTime);
      const remainRatio = Math.max(0, 1 - this.hurtElapsedMs / this.hurtDurationMs);
      const dtScale = Math.max(0, deltaTime) / (1000 / 60);
      this.x += this.knockbackBaseVx * remainRatio * dtScale;
      this.y += this.knockbackBaseVy * remainRatio * dtScale;
      if (this.hurtElapsedMs >= this.hurtDurationMs) {
        this.knockbackBaseVx = 0;
        this.knockbackBaseVy = 0;
      }
    }
    
    // determine rotation target based on left/right input
    if (!controlLocked && this.movingLeft && !this.movingRight) {
      this.targetAngle = -10;
    } else if (!controlLocked && this.movingRight && !this.movingLeft) {
      this.targetAngle = 10;
    } else {
      this.targetAngle = 0;
    }

    // P-control (proportional only). deltaTime is in ms; convert to seconds.
    const dt = Math.max(0, deltaTime) / 1000;
    const error = this.targetAngle - this.angle;
    const angularVelocity = this.rotationKP * error; // deg/s
    this.angle += angularVelocity * dt;

    this.constrainToScreen(game);
    
    if (this.chargeKeyHeld && !this.isCharging && !game.isSkillLifecycleActive(this.side)) {
      this.beginCharging();
    }

    if (this.isCharging && !game.isSkillLifecycleActive(this.side)) {
      this.chargeSystem.addChargeFromHold(deltaTime);
    }
  }
  
  private constrainToScreen(game: Game) {
    // 限制在所属 side 的 viewport 内自由移动（取消之前的 Y 轴下限）
    const viewport = game.getSideViewport(this.side);
    this.x = Math.max(viewport.x, Math.min(this.x, viewport.x + viewport.width - this.width));
    this.y = Math.max(viewport.y, Math.min(this.y, viewport.y + viewport.height - this.height));
  }
  
  render(_ctx: CanvasRenderingContext2D) {
    const ctx = _ctx;
    const palette = this.getPalette();
    const cx = this.x + this.width / 2;
    const cy = this.y + this.height / 2;

    // Draw player on canvas so bullets can be rendered above it by draw order.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((this.angle * Math.PI) / 180);
    if (this.isInHurtState()) {
      ctx.globalAlpha = Math.floor(this.hurtElapsedMs / 80) % 2 === 0 ? 0.35 : 1;
    }
    this.drawCanvasShip(ctx, palette);
    const showHitbox = this.focusEnabled && this.focusMode;
    if (showHitbox) {
      this.drawCanvasHitbox(ctx);
    }
    ctx.restore();

    // Keep SVG path updates for compatibility when SVG mode is enabled.
    if (this.svgGroup && this.svgPath && this.svgGlowPath) {
      this.svgPath.setAttribute('stroke', palette.stroke);
      this.svgPath.setAttribute('fill', palette.fill);
      this.svgGlowPath.setAttribute('stroke', palette.glow);

      if (this.svgHitboxRing && this.svgHitboxCore) {
        this.svgHitboxRing.setAttribute('opacity', showHitbox ? '1' : '0');
        this.svgHitboxCore.setAttribute('opacity', showHitbox ? '1' : '0');
      }

      this.svgGroup.setAttribute('transform', `translate(${cx}, ${cy}) rotate(${this.angle})`);
    }
  }

  private drawCanvasShip(ctx: CanvasRenderingContext2D, palette: { stroke: string; glow: string; fill: string }) {
    const w = this.width;
    const h = this.height;
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.72);
    ctx.lineTo(w * 0.36, -h * 0.12);
    ctx.lineTo(w * 0.6, h * 0.26);
    ctx.lineTo(w * 0.18, h * 0.22);
    ctx.lineTo(w * 0.08, h * 0.58);
    ctx.lineTo(0, h * 0.38);
    ctx.lineTo(-w * 0.08, h * 0.58);
    ctx.lineTo(-w * 0.18, h * 0.22);
    ctx.lineTo(-w * 0.6, h * 0.26);
    ctx.lineTo(-w * 0.36, -h * 0.12);
    ctx.closePath();
    ctx.fillStyle = palette.fill;
    ctx.shadowColor = palette.glow;
    ctx.shadowBlur = Math.max(8, this.width * 0.32);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = palette.stroke;
    ctx.lineWidth = Math.max(2, Math.min(6, this.width / 6));
    ctx.stroke();
  }

  private drawCanvasHitbox(ctx: CanvasRenderingContext2D) {
    const ringColor = this.side === 'left' ? 'rgba(89, 240, 255, 0.92)' : 'rgba(255, 111, 142, 0.92)';
    const coreColor = this.side === 'left' ? 'rgba(89, 240, 255, 0.95)' : 'rgba(255, 111, 142, 0.95)';
    ctx.beginPath();
    ctx.arc(0, 0, this.hitboxRadius + 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fill();
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, this.hitboxRadius, 0, Math.PI * 2);
    ctx.fillStyle = coreColor;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private getPalette() {
    return this.aircraftProfile.getPalette(this.side);
  }
  
  private beginCharging() {
    if (this.isCharging) return;
    this.isCharging = true;
    this.chargeStartTime = Date.now();
    this.chargeSystem.startCharging();
  }

  startCharging(game: Game) {
    if (this.isCharging || game.isSkillLifecycleActive(this.side)) return;
    this.beginCharging();
  }

  onChargeKeyDown(game: Game) {
    this.chargeKeyHeld = true;
    this.chargeKeyDownTime = Date.now();
    if (!game.isSkillLifecycleActive(this.side)) {
      this.beginCharging();
    }
  }

  onChargeKeyUp(game: Game): string {
    const holdDuration = this.chargeKeyDownTime > 0 ? Date.now() - this.chargeKeyDownTime : 0;
    this.chargeKeyHeld = false;
    this.chargeKeyDownTime = 0;

    if (this.isCharging) {
      return this.releaseCharge(game);
    }

    if (holdDuration > 0 && holdDuration < 160) {
      this.shoot(game);
      return 'shoot';
    }

    return 'none';
  }
  
  releaseCharge(game: Game) {
    if (!this.isCharging) return 'none';

    this.isCharging = false;
    const holdDuration = Date.now() - this.chargeStartTime;
    this.chargeStartTime = 0;

    const level = this.chargeSystem.releaseCharge();

    if (holdDuration < 160 && level === 0) {
      this.shoot(game);
      return 'shoot';
    }

    // Level 4 consumes full accumulated gauge (locked to level1 floor after consume).
    if (level === 4) {
      const cost = this.chargeSystem.getMaxChargeCap();
      const ok = this.chargeSystem.consumeCharge(cost);
      if (ok) {
        this.useLevel4Skill(game);
        return 'skill4';
      }
      return 'none';
    }
    // Level 1 should not consume accumulated gauge; fire immediately.
    if (level === 1) {
      const skillTokenId = game.beginSkillLifecycle(this.side);
      this.useLevel1Skill(game, skillTokenId);
      return 'skill1';
    }

    // For level 2 and 3, consume accumulated gauge as a cost.
    if (level === 2 || level === 3) {
      const thresholds = this.chargeSystem.getThresholds();
      const cost = level === 2 ? thresholds.level2 : thresholds.level3;
      const ok = this.chargeSystem.consumeCharge(cost);
      if (ok) {
        const skillTokenId = game.beginSkillLifecycle(this.side);
        if (level === 2) {
          this.useLevel2Skill(game, skillTokenId);
          return 'skill2';
        } else {
          this.useLevel3Skill(game, skillTokenId);
          return 'skill3';
        }
      }
    }

    return 'none';
  }

  // Execute a skill programmatically (used by SkillScheduler).
  // level: 1..4 for charge-based skills. Returns true if executed.
  executeSkill(level: number, game: Game): boolean {
    if (level === 1) {
      const skillTokenId = game.beginSkillLifecycle(this.side);
      this.useLevel1Skill(game, skillTokenId);
      return true;
    }

    if (level === 2 || level === 3) {
      const thresholds = this.chargeSystem.getThresholds();
      const cost = level === 2 ? thresholds.level2 : thresholds.level3;
      const ok = this.chargeSystem.consumeCharge(cost);
      if (ok) {
        const skillTokenId = game.beginSkillLifecycle(this.side);
        if (level === 2) this.useLevel2Skill(game, skillTokenId);
        else this.useLevel3Skill(game, skillTokenId);
        return true;
      }
      return false;
    }

    if (level === 4) {
      const cost = this.chargeSystem.getMaxChargeCap();
      const ok = this.chargeSystem.consumeCharge(cost);
      if (ok) {
        this.useLevel4Skill(game);
        return true;
      }
      return false;
    }

    return false;
  }

  // Return available skills for current player state. Used to build action masks.
  getAvailableSkills(): { skill1: boolean; skill2: boolean; skill3: boolean; skill4: boolean; bomb: boolean } {
    const thresholds = this.chargeSystem.getThresholds();
    const chargeReserve = this.chargeSystem.getChargeMax();
    return {
      skill1: chargeReserve >= thresholds.level1,
      skill2: chargeReserve >= thresholds.level2,
      skill3: chargeReserve >= thresholds.level3,
      skill4: chargeReserve >= this.chargeSystem.getMaxChargeCap(),
      bomb: this.bombs > 0,
    };
  }

  private useBaseAdvancedAttack(game: Game, skillTokenId?: number) {
    this.useLevel1Skill(game, skillTokenId);
  }
  
  private useLevel1Skill(game: Game, skillTokenId?: number) {
    const addBullet = (bullet: Bullet) => {
      if (typeof skillTokenId === 'number') {
        game.addSkillBullet(bullet, skillTokenId);
      } else {
        game.addBullet(bullet);
      }
    };
    this.aircraftProfile.useLevel1Skill({
      player: this,
      game,
      skillTokenId,
      addBullet,
    });
  }
  
  private useLevel2Skill(game: Game, skillTokenId?: number) {
    if (this.aircraftProfile.handleLevel2Skill?.({ player: this, game, skillTokenId, addBullet: (bullet) => game.addBullet(bullet) })) {
      return;
    }

    this.useBaseAdvancedAttack(game, skillTokenId);

    const targetSide = this.side === 'left' ? 'right' : 'left';
    // trigger field on caster's own side (not the opponent)
    game.triggerExpandingField(this.side, this.side, 0.3);
    const targetX = targetSide === 'left'
      ? game.getScreenWidth() * 0.25
      : game.getScreenWidth() * 0.75;

    for (let i = 0; i < 10; i++) {
      game.runWithLifecycle(() => {
        const bullet = new Bullet(
          targetX + (Math.random() - 0.5) * 200,
          0,
          (Math.random() - 0.5) * 2,
          3 + Math.random() * 2,
          'barrage',
          'normal',
          true,
          4,
          10,
          10,
          targetSide
        );
        game.addBullet(bullet);
      }, i * 300);
    }
  }
  
  private useLevel3Skill(game: Game, skillTokenId?: number) {
    if (this.aircraftProfile.handleLevel3Skill?.({ player: this, game, skillTokenId, addBullet: (bullet) => game.addBullet(bullet) })) {
      return;
    }

    this.useBaseAdvancedAttack(game, skillTokenId);

    const targetSide = this.side === 'left' ? 'right' : 'left';
    // trigger field on caster's own side (not the opponent)
    game.triggerExpandingField(this.side, this.side, 0.5);
    const targetX = targetSide === 'left'
      ? game.getScreenWidth() * 0.25
      : game.getScreenWidth() * 0.75;

    for (let i = 0; i < 20; i++) {
      game.runWithLifecycle(() => {
        const bullet = new Bullet(
          targetX + (Math.random() - 0.5) * 200,
          0,
          (Math.random() - 0.5) * 2,
          3 + Math.random() * 2,
          'barrage',
          'special',
          false,
          4,
          10,
          10,
          targetSide
        );
        game.addBullet(bullet);
      }, i * 250);
    }
  }
  
  private useLevel4Skill(game: Game, skillTokenId?: number) {
    if (this.aircraftProfile.handleLevel4Skill?.({ player: this, game, skillTokenId, addBullet: (bullet) => game.addBullet(bullet) })) {
      return;
    }

    this.useBaseAdvancedAttack(game, skillTokenId);

    const targetSide = this.side === 'left' ? 'right' : 'left';
    // trigger field on caster's own side (not the opponent)
    if (typeof skillTokenId === 'number') {
      game.attachSkillField(this.side, this.side, 1, 1000, skillTokenId);
    } else {
      game.triggerExpandingField(this.side, this.side, 1);
    }
    
    const boss = game.getBoss();
    if (boss && boss.side === targetSide) {
      this.useLevel3Skill(game, skillTokenId);
      return;
    }
    
    game.triggerBoss(targetSide, 'scatter');
  }
  
  useBomb(game: Game) {
    if (this.bombs <= 0) return;
    
    this.bombs--;
    
    const bullets = game.getBullets(this.side);
    bullets.forEach(b => b.active = false);
    
    const enemies = game.getEnemies(this.side);
    enemies.forEach(e => e.active = false);
    
    const boss = game.getBoss();
    if (boss && boss.side !== this.side) {
      const damage = boss.maxHealth * 0.75;
      // logging disabled: bomb on boss
      boss.health -= damage;
      // logging disabled: boss health after bomb
      if (boss.health <= 0) {
        // logging disabled: boss killed by bomb
        game.removeBoss();
      }
    }
  }
  
  shoot(game: Game) {
    const currentTime = Date.now();
    if (currentTime - this.lastShootTime < this.shootCooldown) return;

    this.lastShootTime = currentTime;

    const category = this.side === 'left' ? 'player1' : 'player2';
    const bullet = new Bullet(
      this.x + this.width / 2 - 2,
      this.y,
      0,
      -10,
      category,
      'normal',
      false,
      4,
      10,
      2,
      this.side
    );

    game.addBullet(bullet);
  }
  
  getSide(): PlayerSide {
    return this.side;
  }
  
  getChargeSystem(): ChargeSystem {
    return this.chargeSystem;
  }
  
  getComboSystem(): ComboSystem {
    return this.comboSystem;
  }

  setFocusEnabled(enabled: boolean) {
    this.focusEnabled = enabled;
    if (!enabled) {
      this.focusMode = false;
    }
  }

  setFocusMode(active: boolean) {
    if (!this.focusEnabled) {
      this.focusMode = false;
      return;
    }
    this.focusMode = active;
  }

  getHitbox() {
    return {
      x: this.x + this.width / 2,
      y: this.y + this.height / 2,
      radius: this.hitboxRadius,
    };
  }

  isInvincible(): boolean {
    return this.isInHurtState();
  }

  applyDamage(amount: number, game: Game): boolean {
    if (amount <= 0 || this.isInvincible() || this.health <= 0) {
      return false;
    }

    this.health = Math.max(0, this.health - amount);
    this.isCharging = false;
    this.movingLeft = false;
    this.movingRight = false;
    this.movingUp = false;
    this.movingDown = false;

    const angle = Math.random() * Math.PI * 2;
    const baseSpeed = 6;
    this.knockbackBaseVx = Math.cos(angle) * baseSpeed;
    this.knockbackBaseVy = Math.sin(angle) * baseSpeed;
    this.hurtElapsedMs = 0;

    game.triggerExpandingField(this.side, this.side, 0.5, 1300);
    this.chargeSystem.addCharge(20);

    if (!this.lowHpGaugeBoostUsed && this.health > 0 && this.health <= 15) {
      this.lowHpGaugeBoostUsed = true;
      this.chargeSystem.addCharge(this.chargeSystem.getMaxChargeCap());
    }

    return true;
  }

  resetRoundState() {
    this.hurtElapsedMs = this.hurtDurationMs;
    this.knockbackBaseVx = 0;
    this.knockbackBaseVy = 0;
    this.lowHpGaugeBoostUsed = false;
    this.isCharging = false;
    this.chargeKeyHeld = false;
    this.chargeKeyDownTime = 0;
  }

  private isInHurtState(): boolean {
    return this.hurtElapsedMs < this.hurtDurationMs;
  }
}
