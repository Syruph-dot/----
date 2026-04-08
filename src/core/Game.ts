import { Player } from './Player';
import { Enemy } from './Enemy';
import { Bullet } from './Bullet';
import { Boss } from './Boss';
import { ScatterBoss } from './ScatterBoss';
import { LaserBoss } from './LaserBoss';
import { TrackingBoss } from './TrackingBoss';
import { ChargeSystem } from '../systems/ChargeSystem';
import { ComboSystem } from '../systems/ComboSystem';
import { WaveSystem } from '../systems/WaveSystem';
import { AIController } from '../systems/AIController';
import { GameConfig, PlayerSide, AircraftType, GameMode } from '../entities/types';

type ExpandingField = {
  side: PlayerSide;
  ownerSide: PlayerSide;
  x: number;
  y: number;
  elapsed: number;
  duration: number;
  targetRadius: number;
};

export class Game {
  private ctx: CanvasRenderingContext2D;
  private svgOverlay: SVGSVGElement | null = null;
  private readonly dpr: number;
  private lastTime = 0;
  private accumulator = 0;
  private readonly fixedDeltaTime = 1000 / 60;
  private animationFrameId = 0;
  private running = false;
  
  private player1: Player;
  private player2: Player | null = null;
  private aiController: AIController | null = null;
  
  private enemies: Enemy[] = [];
  private bullets: Bullet[] = [];
  private boss: Boss | null = null;
  
  private chargeSystem1: ChargeSystem;
  private chargeSystem2: ChargeSystem | null = null;
  private comboSystem1: ComboSystem;
  private comboSystem2: ComboSystem | null = null;
  private waveSystem: WaveSystem;

  // In-memory buffer for training events (export as needed)
  public trainingEvents: any[] = [];
  
  private gameMode: GameMode = 'single';
  private aiDifficulty: 'easy' | 'normal' | 'hard' = 'normal';
  private gameOver = false;
  private winnerText = '';
  private readonly keyDownListener = (e: KeyboardEvent) => this.handleKeyDown(e);
  private readonly keyUpListener = (e: KeyboardEvent) => this.handleKeyUp(e);
  private readonly managedTimeoutIds = new Set<number>();
  private listenersAttached = false;
  
  private readonly SCREEN_WIDTH: number;
  private readonly SCREEN_HEIGHT: number;
  private readonly MARGIN = 0.1;
  // 防止多怪同时死亡导致爆发式生成弹幕：记录每侧上次生成时间
  private lastBurstSpawnTime: Record<PlayerSide, number> = { left: 0, right: 0 };
  private readonly BURST_COOLDOWN_MS = 300;
  private expandingFields: ExpandingField[] = [];
  
  constructor(canvas: HTMLCanvasElement, config: Partial<GameConfig> = {}) {
    this.ctx = canvas.getContext('2d')!;
    this.gameMode = config.mode ?? 'single';
    this.aiDifficulty = config.difficulty ?? 'normal';
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    
    // 缩小默认游戏画面并限制最大尺寸，避免过大画面导致敌人分布过稀
    const MAX_WIDTH = 1200;
    const MAX_HEIGHT = 800;
    this.SCREEN_WIDTH = Math.min(window.innerWidth * 0.8, MAX_WIDTH);
    this.SCREEN_HEIGHT = Math.min(window.innerHeight * 0.8, MAX_HEIGHT);
    
    canvas.style.width = `${this.SCREEN_WIDTH}px`;
    canvas.style.height = `${this.SCREEN_HEIGHT}px`;
    canvas.width = Math.floor(this.SCREEN_WIDTH * this.dpr);
    canvas.height = Math.floor(this.SCREEN_HEIGHT * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;

    // create SVG overlay aligned on top of the canvas for player rendering
    const container = canvas.parentElement as HTMLElement | null;
    if (container) {
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg') as SVGSVGElement;
      svg.setAttribute('width', String(this.SCREEN_WIDTH));
      svg.setAttribute('height', String(this.SCREEN_HEIGHT));
      svg.style.width = `${this.SCREEN_WIDTH}px`;
      svg.style.height = `${this.SCREEN_HEIGHT}px`;
      svg.style.position = 'absolute';
      svg.style.left = '0';
      svg.style.top = '0';
      svg.style.pointerEvents = 'none';
      svg.style.zIndex = '5';
      container.appendChild(svg);
      this.svgOverlay = svg;
    }
    
    this.chargeSystem1 = new ChargeSystem();
    this.comboSystem1 = new ComboSystem();
    this.waveSystem = new WaveSystem(this);
    
    this.player1 = new Player(
      this.SCREEN_WIDTH * (0.25 - this.MARGIN / 2),
      this.SCREEN_HEIGHT * 0.7,
      'left',
      this.chargeSystem1,
      this.comboSystem1,
      config.player1Aircraft ?? 'scatter',
      undefined
    );
    this.player1.setFocusEnabled(this.gameMode === 'single');

    this.chargeSystem2 = new ChargeSystem();
    this.comboSystem2 = new ComboSystem();
    this.player2 = new Player(
      this.SCREEN_WIDTH * (0.75 - this.MARGIN / 2),
      this.SCREEN_HEIGHT * 0.7,
      'right',
      this.chargeSystem2,
      this.comboSystem2,
      config.player2Aircraft ?? 'scatter',
      undefined
    );
    this.player2.setFocusEnabled(false);

    if (this.gameMode === 'single') {
      this.aiController = new AIController(this, this.player2, 'right', this.aiDifficulty);
    }
    
    console.log('[Game] constructed', {
      mode: this.gameMode,
      difficulty: this.aiDifficulty,
      screenWidth: this.SCREEN_WIDTH,
      screenHeight: this.SCREEN_HEIGHT,
      player1Health: this.player1.health,
      player2Health: this.player2 ? this.player2.health : null
    });
  }
  
  start() {
    if (this.running) return;
    this.running = true;
    this.setupEventListeners();

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }

    // Ensure a fresh match state on start (protect against restart/resume bugs)
    this.gameOver = false;
    this.winnerText = '';

    // Reset players
    if (this.player1) {
      this.player1.health = 100;
      this.player1.bombs = 2;
      this.player1.movingLeft = false;
      this.player1.movingRight = false;
      this.player1.movingUp = false;
      this.player1.movingDown = false;
      this.player1.resetRoundState();
    }

    if (this.player2) {
      this.player2.health = 100;
      this.player2.bombs = 2;
      this.player2.movingLeft = false;
      this.player2.movingRight = false;
      this.player2.movingUp = false;
      this.player2.movingDown = false;
      this.player2.resetRoundState();
    }

    // Reset systems
    if (this.comboSystem1) this.comboSystem1.reset();
    if (this.comboSystem2) this.comboSystem2.reset();
    if (this.chargeSystem1) this.chargeSystem1.resetCurrentCharge();
    if (this.chargeSystem2) this.chargeSystem2.resetCurrentCharge();

    // Clear entities
    this.enemies = [];
    this.bullets = [];
    this.boss = null;
    this.expandingFields = [];

    // Recreate wave system and AI controller to reset internal counters
    this.waveSystem = new WaveSystem(this);
    if (this.gameMode === 'single') {
      this.aiController = new AIController(this, this.player2!, 'right', this.aiDifficulty);
    } else {
      this.aiController = null;
    }

    this.lastTime = performance.now();
    this.accumulator = 0;
    this.render();
    this.animationFrameId = requestAnimationFrame((t) => this.gameLoop(t));
  }

  // Append a training event to in-memory buffer. Lightweight and safe to call frequently.
  pushTrainingEvent(ev: any) {
    this.trainingEvents.push(ev);
  }

  getTrainingEventsJSONL(): string {
    return this.trainingEvents.map((event) => JSON.stringify(event)).join('\n');
  }

  getTrainingEventsCSV(): string {
    return this.formatTrainingEventsCSV(this.trainingEvents);
  }

  private formatTrainingEventsCSV(rows: any[]): string {
    const headers = [
      'ts', 'side', 'playerCenterX', 'playerCenterY', 'movementScore', 'threat', 'nearbyBulletCount', 'nearbyBullets',
      'chargeMax', 'currentCharge', 'selfHealth', 'opponentHealth', 'bossSide', 'bossHealth', 'bossMaxHealth', 'scenarioTags', 'rareScore',
      'skillRequested', 'skillExecuted', 'skillMask', 'movementTargetX', 'movementTargetY'
    ];
    const escapeCell = (value: unknown) => {
      const text = value === undefined || value === null ? '' : String(value);
      if (/[",\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    };

    const lines = [headers.join(',')];
    for (const row of rows) {
      const target = row.movementTarget ?? {};
      const playerCenter = row.playerCenter ?? {};
      const boss = row.boss ?? {};
      const nearbyBullets = JSON.stringify(row.nearbyBullets ?? []);
      const scenarioTags = JSON.stringify(row.scenarioTags ?? []);

      lines.push([
        row.ts,
        row.side,
        playerCenter.x ?? '',
        playerCenter.y ?? '',
        row.movementScore,
        row.threat,
        row.nearbyBulletCount,
        nearbyBullets,
        row.chargeMax ?? '',
        row.currentCharge ?? '',
        row.selfHealth ?? '',
        row.opponentHealth ?? '',
        boss.side ?? '',
        boss.health ?? '',
        boss.maxHealth ?? '',
        scenarioTags,
        row.rareScore ?? '',
        row.skillRequested,
        row.skillExecuted,
        JSON.stringify(row.skillMask ?? []),
        target.x ?? '',
        target.y ?? '',
      ].map(escapeCell).join(','));
    }

    return lines.join('\n');
  }

  getRareTrainingEvents(): any[] {
    return this.trainingEvents.filter((event) => {
      if (typeof event?.rareScore === 'number' && event.rareScore > 0) {
        return true;
      }

      const tags = Array.isArray(event?.scenarioTags) ? event.scenarioTags : [];
      return tags.some((tag: string) => [
        'high_threat',
        'low_health',
        'opponent_low_health',
        'boss_present',
        'boss_on_my_side',
        'skill2_action',
        'skill3_action',
        'skill4_action',
      ].includes(tag));
    });
  }

  getRareTrainingEventsJSONL(): string {
    return this.getRareTrainingEvents().map((event) => JSON.stringify(event)).join('\n');
  }

  getRareTrainingEventsCSV(): string {
    return this.formatTrainingEventsCSV(this.getRareTrainingEvents());
  }

  downloadTrainingEvents(format: 'jsonl' | 'csv' | 'rare-jsonl' | 'rare-csv' = 'jsonl') {
    const isRare = format.startsWith('rare-');
    const baseFormat = isRare ? format.replace('rare-', '') as 'jsonl' | 'csv' : format;
    const content = baseFormat === 'csv'
      ? (isRare ? this.getRareTrainingEventsCSV() : this.getTrainingEventsCSV())
      : (isRare ? this.getRareTrainingEventsJSONL() : this.getTrainingEventsJSONL());
    const filename = isRare
      ? (baseFormat === 'csv' ? 'training-events-rare.csv' : 'training-events-rare.jsonl')
      : (baseFormat === 'csv' ? 'training-events.csv' : 'training-events.jsonl');
    const mimeType = baseFormat === 'csv' ? 'text/csv;charset=utf-8' : 'application/jsonl;charset=utf-8';

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  destroy() {
    this.running = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }
    for (const timeoutId of this.managedTimeoutIds) {
      clearTimeout(timeoutId);
    }
    this.managedTimeoutIds.clear();
    this.removeEventListeners();

    if (this.svgOverlay && this.svgOverlay.parentElement) {
      this.svgOverlay.parentElement.removeChild(this.svgOverlay);
      this.svgOverlay = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  runWithLifecycle(callback: () => void, delayMs: number): number {
    const timeoutId = window.setTimeout(() => {
      this.managedTimeoutIds.delete(timeoutId);
      if (!this.running) {
        return;
      }
      callback();
    }, delayMs);

    this.managedTimeoutIds.add(timeoutId);
    return timeoutId;
  }
  
  private gameLoop(currentTime: number) {
    if (!this.running) {
      return;
    }

    if (this.lastTime === 0) {
      this.lastTime = currentTime;
      this.animationFrameId = requestAnimationFrame((t) => this.gameLoop(t));
      return;
    }

    const rawDeltaTime = currentTime - this.lastTime;
    const deltaTime = Math.min(rawDeltaTime, 100);
    this.lastTime = currentTime;
    this.accumulator += deltaTime;
    
    while (this.accumulator >= this.fixedDeltaTime) {
      this.update(this.fixedDeltaTime);
      this.accumulator -= this.fixedDeltaTime;
    }
    
    this.render();
    
    this.animationFrameId = requestAnimationFrame((t) => this.gameLoop(t));
  }
  
  private update(deltaTime: number) {
    if (this.gameOver) {
      return;
    }

    this.player1.update(deltaTime, this);
    
    if (this.player2) {
      this.player2.update(deltaTime, this);
    }
    
    if (this.aiController) {
      this.aiController.update(deltaTime);
    }
    
    this.waveSystem.update(deltaTime);
    this.updateExpandingFields(deltaTime);
    
    for (let enemy of this.enemies) {
      enemy.update(deltaTime, this);
    }
    
    for (let bullet of this.bullets) {
      bullet.update(deltaTime);

      if (bullet.active && !bullet.isTransferringState() && this.shouldCullBullet(bullet)) {
        bullet.active = false;
      }
    }
    
    if (this.boss) {
      this.boss.update(deltaTime, this);
      if (!this.boss.active) {
        this.boss = null;
      }
    }
    
    this.checkCollisions();
    
    this.comboSystem1.update(deltaTime);
    if (this.comboSystem2) {
      this.comboSystem2.update(deltaTime);
    }
    
    this.bullets = this.bullets.filter(b => b.active);
    this.enemies = this.enemies.filter(e => e.active);
    this.updateGameOverState();
  }
  
  private render() {
    this.ctx.clearRect(0, 0, this.SCREEN_WIDTH, this.SCREEN_HEIGHT);

    this.renderSideWorld('left');
    this.renderSideWorld('right');
    this.renderScreenDivider();
    
    this.renderUI();

    if (this.gameOver) {
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      this.ctx.fillRect(0, 0, this.SCREEN_WIDTH, this.SCREEN_HEIGHT);
      this.ctx.fillStyle = '#ffffff';
      this.ctx.font = '36px Microsoft YaHei';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(this.winnerText, this.SCREEN_WIDTH / 2, this.SCREEN_HEIGHT / 2);
    }
  }

  private renderSideWorld(side: PlayerSide) {
    const viewport = this.getSideViewport(side);

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(viewport.x, viewport.y, viewport.width, viewport.height);
    this.ctx.clip();

    this.renderArenaBackdrop(side, viewport);

    const player = this.getPlayer(side);
    if (player) {
      player.render(this.ctx);
    }

    for (const enemy of this.enemies) {
      if (enemy.side !== side) continue;
      enemy.render(this.ctx);
    }

    this.renderExpandingFields(side);

    for (const bullet of this.bullets) {
      if (bullet.side !== side) continue;
      bullet.render(this.ctx);
    }

    if (this.boss && this.boss.side === side) {
      this.boss.render(this.ctx);
    }

    this.ctx.restore();
  }
  
  private renderScreenDivider() {
    const dividerX = this.SCREEN_WIDTH / 2;
    const marginWidth = this.SCREEN_WIDTH * this.MARGIN / 2;

    const stripX = dividerX - marginWidth;
    const stripWidth = marginWidth * 2;

    const dividerGradient = this.ctx.createLinearGradient(stripX, 0, stripX + stripWidth, 0);
    dividerGradient.addColorStop(0, 'rgba(89, 240, 255, 0.02)');
    dividerGradient.addColorStop(0.5, 'rgba(234, 69, 96, 0.16)');
    dividerGradient.addColorStop(1, 'rgba(255, 209, 102, 0.04)');
    this.ctx.fillStyle = dividerGradient;
    this.ctx.fillRect(stripX, 0, stripWidth, this.SCREEN_HEIGHT);

    this.ctx.save();
    this.ctx.shadowColor = 'rgba(234, 69, 96, 0.45)';
    this.ctx.shadowBlur = 18;
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.moveTo(dividerX, 0);
    this.ctx.lineTo(dividerX, this.SCREEN_HEIGHT);
    this.ctx.stroke();
    this.ctx.restore();

    this.ctx.strokeStyle = 'rgba(89, 240, 255, 0.22)';
    this.ctx.lineWidth = 1;
    for (let y = 10; y < this.SCREEN_HEIGHT; y += 36) {
      this.ctx.beginPath();
      this.ctx.moveTo(dividerX - 10, y);
      this.ctx.lineTo(dividerX + 10, y + 8);
      this.ctx.stroke();
    }
  }
  
  private renderUI() {
    const leftPanel = { x: 16, y: 16, w: 280, h: 122 };
    const rightPanel = { x: this.SCREEN_WIDTH - 296, y: 16, w: 280, h: 122 };
    const leftViewport = this.getSideViewport('left');
    const rightViewport = this.getSideViewport('right');
    const gaugeHorizontalInset = 10;
    const gaugeBottomInset = 12;
    const gaugeHeight = 16;
    const leftGaugeX = leftViewport.x + gaugeHorizontalInset;
    const rightGaugeX = rightViewport.x + gaugeHorizontalInset;
    const gaugeY = this.SCREEN_HEIGHT - gaugeHeight - gaugeBottomInset;
    const leftGaugeWidth = Math.max(120, leftViewport.width - gaugeHorizontalInset * 2);
    const rightGaugeWidth = Math.max(120, rightViewport.width - gaugeHorizontalInset * 2);

    this.drawHudPanel(leftPanel.x, leftPanel.y, leftPanel.w, leftPanel.h, 'P1 / LEFT', '#59f0ff');
    this.drawHudPanel(rightPanel.x, rightPanel.y, rightPanel.w, rightPanel.h, 'P2 / RIGHT', '#ff6f8e');

    this.ctx.fillStyle = '#eef4ff';
    this.ctx.font = '700 15px Microsoft YaHei';
    this.ctx.textAlign = 'left';

    this.renderHudStat(32, 50, '连击', String(this.comboSystem1.getCombo()));
    this.renderHudStat(32, 74, '血量', String(this.player1.health));
    this.renderHudStat(32, 98, '炸弹', String(this.player1.bombs));

    this.renderChargeBar(this.ctx, leftGaugeX, gaugeY, leftGaugeWidth, gaugeHeight, this.chargeSystem1, this.player1.getSide());
    
    if (this.player2 && this.chargeSystem2 && this.comboSystem2) {
      this.renderHudStat(this.SCREEN_WIDTH - 260, 50, '连击', String(this.comboSystem2.getCombo()));
      this.renderHudStat(this.SCREEN_WIDTH - 260, 74, '血量', String(this.player2.health));
      this.renderHudStat(this.SCREEN_WIDTH - 260, 98, '炸弹', String(this.player2.bombs));
      
      this.renderChargeBar(
        this.ctx, 
        rightGaugeX, 
        gaugeY,
        rightGaugeWidth,
        gaugeHeight,
        this.chargeSystem2, 
        this.player2.getSide()
      );

      if (this.aiController) {
        const chargeIntent = this.aiController.getChargeIntent();
        this.ctx.textAlign = 'left';
        this.ctx.fillStyle = chargeIntent.isCharging ? '#ffd166' : '#9eb2d7';
        if (chargeIntent.isCharging) {
          const percent = Math.round(chargeIntent.progress * 100);
          this.ctx.fillText(`AI蓄力: ${chargeIntent.skill} ${percent}%`, this.SCREEN_WIDTH - 248, 146);
        } else {
          this.ctx.fillText('AI蓄力: idle', this.SCREEN_WIDTH - 248, 146);
        }
      }
    }
  }

  private renderHudStat(x: number, y: number, label: string, value: string) {
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    this.ctx.font = '12px Microsoft YaHei';
    this.ctx.fillText(label, x, y);
    this.ctx.textAlign = 'right';
    this.ctx.fillStyle = '#eef4ff';
    this.ctx.font = '700 15px Microsoft YaHei';
    this.ctx.fillText(value, x + 96, y);
    this.ctx.textAlign = 'left';
  }
  
  private renderChargeBar(
    ctx: CanvasRenderingContext2D, 
    x: number, 
    y: number, 
    width: number, 
    height: number,
    chargeSystem: ChargeSystem,
    side: PlayerSide
  ) {
    const chargeMax = chargeSystem.getChargeMax();
    const currentCharge = chargeSystem.getCurrentCharge();
    const maxCharge = chargeSystem.getMaxChargeCap();
    const thresholds = chargeSystem.getThresholds();
    const palette = side === 'left'
      ? { base: '#59f0ff', glow: 'rgba(89, 240, 255, 0.65)' }
      : { base: '#ff6f8e', glow: 'rgba(255, 111, 142, 0.65)' };
    
    ctx.save();
    this.drawRoundedRect(ctx, x, y, width, height, height / 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.stroke();

    const accumulatedWidth = Math.max(0, Math.min(width, (chargeMax / maxCharge) * width));
    this.drawRoundedRect(ctx, x, y, accumulatedWidth, height, height / 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fill();

    const safeCurrent = Math.min(currentCharge, chargeMax);
    const filledWidth = Math.max(0, Math.min(width, (safeCurrent / maxCharge) * width));
    const fillGradient = ctx.createLinearGradient(x, y, x + width, y);
    fillGradient.addColorStop(0, palette.base);
    fillGradient.addColorStop(1, side === 'left' ? '#b8ffff' : '#ffb1c0');
    this.drawRoundedRect(ctx, x, y, filledWidth, height, height / 2);
    ctx.fillStyle = fillGradient;
    ctx.fill();
    ctx.shadowColor = palette.glow;
    ctx.shadowBlur = 10;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(x, y, Math.min(18, filledWidth), height);
    
    ctx.shadowBlur = 0;
    
    const thresholdX1 = x + (thresholds.level1 / maxCharge) * width;
    const thresholdX2 = x + (thresholds.level2 / maxCharge) * width;
    const thresholdX3 = x + (thresholds.level3 / maxCharge) * width;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.52)';
    ctx.lineWidth = 1;
    [thresholdX1, thresholdX2, thresholdX3].forEach((tickX) => {
      ctx.beginPath();
      ctx.moveTo(tickX, y - 1);
      ctx.lineTo(tickX, y + height + 1);
      ctx.stroke();
    });

    ctx.strokeStyle = 'rgba(255, 209, 102, 0.64)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y + height / 2);
    ctx.lineTo(x + width, y + height / 2);
    ctx.stroke();
    
    ctx.fillStyle = '#dbe7ff';
    ctx.font = '10px Microsoft YaHei';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(chargeMax)}/${maxCharge}`, x + width - 4, y - 4);
    ctx.restore();
  }

  private drawHudPanel(x: number, y: number, width: number, height: number, title: string, accent: string) {
    this.ctx.save();
    this.drawRoundedRect(this.ctx, x, y, width, height, 18);
    const panelGradient = this.ctx.createLinearGradient(x, y, x, y + height);
    panelGradient.addColorStop(0, 'rgba(13, 22, 42, 0.82)');
    panelGradient.addColorStop(1, 'rgba(7, 12, 26, 0.9)');
    this.ctx.fillStyle = panelGradient;
    this.ctx.fill();
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    this.ctx.stroke();

    this.ctx.fillStyle = accent;
    this.ctx.fillRect(x + 14, y + 14, 54, 3);
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
    this.ctx.font = '700 12px Microsoft YaHei';
    this.ctx.textAlign = 'left';
    this.ctx.fillText(title, x + 14, y + 34);
    this.ctx.restore();
  }

  private renderArenaBackdrop(side: PlayerSide, viewport: { x: number; y: number; width: number; height: number }) {
    const accent = side === 'left' ? 'rgba(89, 240, 255, 0.15)' : 'rgba(255, 111, 142, 0.15)';
    const baseGradient = this.ctx.createLinearGradient(viewport.x, viewport.y, viewport.x, viewport.y + viewport.height);
    baseGradient.addColorStop(0, 'rgba(9, 15, 31, 0.88)');
    baseGradient.addColorStop(1, 'rgba(5, 8, 18, 0.96)');
    this.ctx.fillStyle = baseGradient;
    this.ctx.fillRect(viewport.x, viewport.y, viewport.width, viewport.height);

    this.ctx.save();
    this.ctx.globalAlpha = 0.12;
    this.ctx.strokeStyle = accent;
    this.ctx.lineWidth = 1;
    const gridStep = 36;
    for (let gx = viewport.x; gx <= viewport.x + viewport.width; gx += gridStep) {
      this.ctx.beginPath();
      this.ctx.moveTo(gx, viewport.y);
      this.ctx.lineTo(gx, viewport.y + viewport.height);
      this.ctx.stroke();
    }
    for (let gy = viewport.y; gy <= viewport.y + viewport.height; gy += gridStep) {
      this.ctx.beginPath();
      this.ctx.moveTo(viewport.x, gy);
      this.ctx.lineTo(viewport.x + viewport.width, gy);
      this.ctx.stroke();
    }

    const scanPhase = (performance.now() * 0.02) % viewport.height;
    const scanY = viewport.y + scanPhase;
    const scanGradient = this.ctx.createLinearGradient(viewport.x, scanY - 24, viewport.x, scanY + 24);
    scanGradient.addColorStop(0, 'transparent');
    scanGradient.addColorStop(0.5, accent);
    scanGradient.addColorStop(1, 'transparent');
    this.ctx.fillStyle = scanGradient;
    this.ctx.fillRect(viewport.x, scanY - 18, viewport.width, 36);
    this.ctx.restore();

    this.ctx.save();
    this.ctx.strokeStyle = side === 'left' ? 'rgba(89, 240, 255, 0.18)' : 'rgba(255, 111, 142, 0.18)';
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(viewport.x + 1, viewport.y + 1, viewport.width - 2, viewport.height - 2);
    this.ctx.restore();
  }

  private drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
    const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  private updateExpandingFields(deltaTime: number) {
    if (this.expandingFields.length === 0) {
      return;
    }

    for (const field of this.expandingFields) {
      field.elapsed = Math.min(field.duration, field.elapsed + deltaTime);
      const progress = field.duration <= 0 ? 1 : field.elapsed / field.duration;
      const radius = field.targetRadius * progress;
      const radiusSq = radius * radius;

      for (const bullet of this.bullets) {
        if (!bullet.active || bullet.side !== field.side) {
          continue;
        }

        const ownCategory = field.ownerSide === 'left' ? 'player1' : 'player2';
        if (bullet.category === ownCategory) {
          continue;
        }

        const bx = bullet.x + bullet.width / 2;
        const by = bullet.y + bullet.height / 2;
        const dx = bx - field.x;
        const dy = by - field.y;
        if (dx * dx + dy * dy <= radiusSq) {
          bullet.active = false;
          // 标记为力场消除，避免这些子弹被计入蓄力（或后续转移计分）
          (bullet as any).destroyedByExpandingField = true;
        }
      }

      for (const enemy of this.enemies) {
        if (!enemy.active || enemy.side !== field.side) {
          continue;
        }

        const ex = enemy.x + enemy.width / 2;
        const ey = enemy.y + enemy.height / 2;
        const dx = ex - field.x;
        const dy = ey - field.y;
        if (dx * dx + dy * dy <= radiusSq) {
          enemy.active = false;
        }
      }
    }

    this.expandingFields = this.expandingFields.filter((field) => field.elapsed < field.duration);
  }

  private renderExpandingFields(side: PlayerSide) {
    for (const field of this.expandingFields) {
      if (field.side !== side) {
        continue;
      }

      const progress = field.duration <= 0 ? 1 : field.elapsed / field.duration;
      const radius = field.targetRadius * progress;
      const alpha = 0.18 * (1 - progress * 0.35);
      const stroke = side === 'left' ? 'rgba(89, 240, 255, 0.62)' : 'rgba(255, 111, 142, 0.62)';

      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.arc(field.x, field.y, radius, 0, Math.PI * 2);
      this.ctx.fillStyle = side === 'left'
        ? `rgba(89, 240, 255, ${alpha})`
        : `rgba(255, 111, 142, ${alpha})`;
      this.ctx.fill();
      this.ctx.strokeStyle = stroke;
      this.ctx.lineWidth = 2;
      this.ctx.stroke();
      this.ctx.restore();
    }
  }

  triggerExpandingField(targetSide: PlayerSide, ownerSide: PlayerSide, radiusRatio: number, durationMs = 1000) {
    const viewport = this.getSideViewport(targetSide);
    const targetPlayer = this.getPlayer(targetSide);
    const centerX = targetPlayer ? targetPlayer.x + targetPlayer.width / 2 : viewport.x + viewport.width / 2;
    const centerY = targetPlayer ? targetPlayer.y + targetPlayer.height / 2 : viewport.y + viewport.height / 2;
    const clampedRatio = Math.max(0, radiusRatio);
    const targetRadius = Math.max(1, viewport.width * clampedRatio);

    this.expandingFields.push({
      side: targetSide,
      ownerSide,
      x: centerX,
      y: centerY,
      elapsed: 0,
      duration: Math.max(1, durationMs),
      targetRadius,
    });
  }
  
  private checkCollisions() {
    const enemyCollisionDamage = 15;

    for (let bullet of this.bullets) {
      if (!bullet.active) continue;

      // ===== 玩家子弹 (player1/player2)：只伤害敌机/Boss =====
      if (bullet.category === 'player1' || bullet.category === 'player2') {
        // player1 命中左侧战区敌机，player2 命中右侧战区敌机
        const targetSide = bullet.category === 'player1' ? 'left' : 'right';

        // 检测与敌机碰撞
        for (const enemy of this.enemies) {
          if (enemy.side !== targetSide || !enemy.active) {
            continue;
          }

          if (bullet.bulletType === 'special' && bullet.hasHit(enemy)) {
            continue;
          }

          if (!this.isColliding(bullet, enemy)) {
            continue;
          }

          bullet.markHit(enemy);
          enemy.health -= bullet.damage;

          // 特殊子弹不消失，普通子弹消失
          if (bullet.bulletType === 'normal') {
            bullet.active = false;
          }

          if (enemy.health <= 0) {
            enemy.health = 0;
            enemy.active = false;
            this.onEnemyKilled(enemy, targetSide);
          }

          if (bullet.bulletType === 'normal') {
            break;
          }
        }

        // 检测与Boss碰撞
        if (bullet.active && this.boss && this.boss.side === targetSide) {
          if (bullet.bulletType === 'special' && bullet.hasHit(this.boss)) {
            continue;
          }

          if (this.isColliding(bullet, this.boss)) {
                const beforeHealth = this.boss.health;
                if (typeof console !== 'undefined') {
                  console.debug('[Game] boss hit attempt', {
                    source: 'bullet',
                    category: bullet.category,
                    bulletSide: bullet.side,
                    bulletType: bullet.bulletType,
                    damage: bullet.damage,
                    bx: bullet.x,
                    by: bullet.y,
                    ts: Date.now(),
                  });
                }

                bullet.markHit(this.boss);
                this.boss.health -= bullet.damage;

                if (typeof console !== 'undefined') {
                  console.debug('[Game] boss health changed', { before: beforeHealth, after: this.boss.health });
                }

                if (bullet.bulletType === 'normal') {
                  bullet.active = false;
                }

                if (this.boss.health <= 0) {
                  const bossSide = this.boss.side;
                  if (typeof console !== 'undefined') {
                    console.warn('[Game] boss killed', { side: bossSide, killer: bullet.category, damage: bullet.damage, ts: Date.now() });
                  }
                  this.removeBoss();
                  this.onBossKilled(bossSide);
                }
          }
        }
        continue;  // 玩家子弹不检测与玩家碰撞，不消除任何子弹
      }

      // ===== 弹幕 (barrage)：只伤害玩家 =====
      if (bullet.category === 'barrage') {
        const targetPlayer = bullet.side === 'left' ? this.player1 : this.player2;

        if (targetPlayer && this.isCollidingWithPlayerHitbox(bullet, targetPlayer)) {
            const tookDamage = targetPlayer.applyDamage(bullet.damage, this);
            bullet.active = false;

            // 被弹幕命中时清空该侧连击
            if (tookDamage) {
              const side = targetPlayer.getSide();
              if (side === 'left') {
                this.comboSystem1.reset();
              } else {
                if (this.comboSystem2) this.comboSystem2.reset();
              }
            }
        }
      }
    }

    // ===== 玩家与杂兵接触碰撞：玩家扣血，杂兵消失 =====
    for (const enemy of this.enemies) {
      if (!enemy.active) continue;

      const targetPlayer = enemy.side === 'left' ? this.player1 : this.player2;
      if (!targetPlayer) continue;

      if (this.isCollidingWithPlayerHitbox(enemy, targetPlayer)) {
        const tookDamage = targetPlayer.applyDamage(enemyCollisionDamage, this);
        enemy.active = false;

        // 接触受伤同样会清空该侧连击
        if (tookDamage) {
          const side = targetPlayer.getSide();
          if (side === 'left') {
            this.comboSystem1.reset();
          } else {
            if (this.comboSystem2) this.comboSystem2.reset();
          }
        }
      }
    }

    // 注意：玩家子弹不能消除弹幕！消弹只能通过小怪爆炸！
  }
  
  private isColliding(a: { x: number; y: number; width: number; height: number }, 
                      b: { x: number; y: number; width: number; height: number }): boolean {
    return a.x < b.x + b.width &&
           a.x + a.width > b.x &&
           a.y < b.y + b.height &&
           a.y + a.height > b.y;
  }

  private isCollidingWithPlayerHitbox(
    a: { x: number; y: number; width: number; height: number },
    player: Player
  ): boolean {
    const hitbox = player.getHitbox();
    const nearestX = Math.max(a.x, Math.min(hitbox.x, a.x + a.width));
    const nearestY = Math.max(a.y, Math.min(hitbox.y, a.y + a.height));
    const dx = hitbox.x - nearestX;
    const dy = hitbox.y - nearestY;
    return dx * dx + dy * dy <= hitbox.radius * hitbox.radius;
  }
  
  private onEnemyKilled(enemy: Enemy, side: PlayerSide) {
    if (side === 'left') {
      this.comboSystem1.increment();
      // 每个击杀基础增量为 1，根据当前连击应用倍率（>20 -> x2, >10 -> x1.5）
      const combo1 = this.comboSystem1.getCombo();
      const mult1 = combo1 > 20 ? 2 : combo1 > 10 ? 1.5 : 1;
      // 将基础击杀加成从 1 调整到 0.7，以减缓早期过快蓄力
      this.chargeSystem1.addCharge(0.7 * mult1);
      
      if (this.comboSystem1.getCombo() >= 30) {
        this.triggerBoss('right');
        this.comboSystem1.reset();
      }
    } else if (side === 'right' && this.chargeSystem2 && this.comboSystem2) {
      this.comboSystem2.increment();
      const combo2 = this.comboSystem2.getCombo();
      const mult2 = combo2 > 20 ? 2 : combo2 > 10 ? 1.5 : 1;
      this.chargeSystem2.addCharge(0.7 * mult2);
      
      if (this.comboSystem2.getCombo() >= 30) {
        this.triggerBoss('left');
        this.comboSystem2.reset();
      }
    }
    
    this.triggerExplosion(enemy, side);
  }
  
  private triggerExplosion(enemy: Enemy, side: PlayerSide) {
    const centerX = enemy.x + enemy.width / 2;
    const centerY = enemy.y + enemy.height / 2;
    const destroyRadius = Math.max(enemy.width, enemy.height) + 4;

    // 找出范围内可被消除的弹幕，范围随小怪尺寸同步放大
    const destroyableNearby = this.bullets.filter(b => {
      // only consider active, non-transferring barrage bullets that can be destroyed
      if (!b.active) return false;
      if (typeof (b as any).isTransferringState === 'function' && (b as any).isTransferringState()) return false;
      const bulletCenterX = b.x + b.width / 2;
      const bulletCenterY = b.y + b.height / 2;
      const dist = Math.hypot(bulletCenterX - centerX, bulletCenterY - centerY);
      return dist < destroyRadius && b.category === 'barrage' && b.canBeDestroyed;
    });

    destroyableNearby.forEach(b => {
      b.active = false;
    });

    // 提高转移概率：90% 概率至少转移 1 个，10% 概率转移 2 个（总体至少转移概率 90%）
    const roll = Math.random();
    let transferCount = 0;
    if (roll < 0.1) {
      transferCount = 2;
    } else if (roll < 0.5) {
      transferCount = 1;
    } else {
      transferCount = 0;
    }

    if (transferCount > 0 && destroyableNearby.length > 0) {
      const targetCategory = side === 'left' ? 'player2' : 'player1';
      const targetSide = targetCategory === 'player1' ? 'left' : 'right';
      const targetPlayer = this.getPlayer(targetSide);
      const aimTarget = targetPlayer
        ? { x: targetPlayer.x + targetPlayer.width / 2, y: targetPlayer.y + targetPlayer.height / 2 }
        : undefined;
      const targetPool = destroyableNearby.slice(0, Math.min(transferCount, destroyableNearby.length));

      targetPool.forEach(b => {
        const targetX = targetCategory === 'player1'
          ? Math.random() * (this.SCREEN_WIDTH * 0.45)
          : this.SCREEN_WIDTH * 0.55 + Math.random() * (this.SCREEN_WIDTH * 0.45);
        const targetY = Math.random() * (this.SCREEN_HEIGHT * 0.4);
        b.startTransfer(targetX, targetY, 750, targetCategory, targetSide, aimTarget);
        // 每传送一个子弹，给予触发该爆炸（也即击杀方）基础蓄力（下调至 0.7），并按连击倍率加成
        // 但如果该子弹是被扩张力场直接消掉的，则不计入蓄力
        if ((b as any).destroyedByExpandingField) {
          return;
        }

        if (side === 'left') {
          const combo1 = this.comboSystem1.getCombo();
          const mult1 = combo1 > 20 ? 2 : combo1 > 10 ? 1.5 : 1;
          this.chargeSystem1.addCharge(0.7 * mult1);
        } else {
          if (this.chargeSystem2 && this.comboSystem2) {
            const combo2 = this.comboSystem2.getCombo();
            const mult2 = combo2 > 20 ? 2 : combo2 > 10 ? 1.5 : 1;
            this.chargeSystem2.addCharge(0.7 * mult2);
          }
        }
      });
    }

    // 80% 概率把被击杀的小怪直接在对方界面生成若干弹幕（带转移动画），弹幕为向下 ±37° 散射
    if (Math.random() < 0.8) {
      const targetSide = side === 'left' ? 'right' : 'left';
      // 防止多只小怪在极短时间内累计生成大量弹幕：按目标侧做冷却合并
      const now = performance.now();
      const last = this.lastBurstSpawnTime[targetSide] ?? 0;
      if (now - last >= this.BURST_COOLDOWN_MS) {
        const viewport = this.getSideViewport(targetSide);
        // 弹幕数量随小怪血量略有增长（hp:2->5,4->6,6->7,8->8）
        const bulletCount = 4 + Math.floor(enemy.health / 2);

        for (let i = 0; i < bulletCount; i++) {
          const startX = enemy.x + enemy.width / 2;
          const startY = enemy.y + enemy.height / 2;
          const destX = viewport.x + Math.random() * viewport.width;
          const destY = viewport.y + Math.random() * (viewport.height * 0.4);

          const nb = new Bullet(
            startX,
            startY,
            0,
            0,
            'barrage',
            'normal',
            true,
            4,
            10,
            10,
            targetSide
          );
          // 使用转移动画到目标点，完成后会设定向下 ±37° 的速度
          const targetPlayer = this.getPlayer(targetSide);
          const aimTarget = targetPlayer
            ? { x: targetPlayer.x + targetPlayer.width / 2, y: targetPlayer.y + targetPlayer.height / 2 }
            : undefined;
          nb.startTransfer(destX, destY, 600, 'barrage', targetSide, aimTarget);
          this.addBullet(nb);
        }

        this.lastBurstSpawnTime[targetSide] = now;
      } else {
        // 跳过本次生成（最近已生成过），但已存在的可转移子弹仍会被处理
      }
    }
  }

  private onBossKilled(side: PlayerSide) {
    if (side === 'left') {
      this.chargeSystem1.addCharge(30);
      return;
    }

    if (this.chargeSystem2) {
      this.chargeSystem2.addCharge(30);
    }
  }
  
  triggerBoss(side: PlayerSide, aircraftType: AircraftType = 'scatter') {
    if (this.boss) {
      this.boss = null;
    }

    const bossX = side === 'left'
      ? this.SCREEN_WIDTH * 0.25
      : this.SCREEN_WIDTH * 0.75;

    switch (aircraftType) {
      case 'scatter':
        this.boss = new ScatterBoss(bossX, 100, side);
        break;
      case 'laser':
        this.boss = new LaserBoss(bossX, 100, side);
        break;
      case 'tracking':
        this.boss = new TrackingBoss(bossX, 100, side);
        break;
      default:
        this.boss = new ScatterBoss(bossX, 100, side);
        break;
    }
  }

  removeBoss() {
    this.boss = null;
  }
  
  addBullet(bullet: Bullet) {
    if (!this.running) {
      return;
    }
    this.bullets.push(bullet);
  }
  
  addEnemy(enemy: Enemy) {
    if (!this.running) {
      return;
    }
    this.enemies.push(enemy);
  }
  
  getPlayer(side: PlayerSide): Player | null {
    return side === 'left' ? this.player1 : this.player2;
  }
  
  getEnemies(side: PlayerSide): Enemy[] {
    return this.enemies.filter(e => e.side === side);
  }
  
  getBullets(side: PlayerSide): Bullet[] {
    return this.bullets.filter(b => b.side === side);
  }
  
  getBoss(): Boss | null {
    return this.boss;
  }
  
  getScreenWidth(): number {
    return this.SCREEN_WIDTH;
  }
  
  getScreenHeight(): number {
    return this.SCREEN_HEIGHT;
  }
  
  getMargin(): number {
    return this.MARGIN;
  }

  getSideViewport(side: PlayerSide): { x: number; y: number; width: number; height: number } {
    const marginWidth = this.SCREEN_WIDTH * this.MARGIN / 2;
    const dividerLeft = this.SCREEN_WIDTH * 0.5 - marginWidth;
    const dividerRight = this.SCREEN_WIDTH * 0.5 + marginWidth;

    if (side === 'left') {
      return {
        x: 0,
        y: 0,
        width: dividerLeft,
        height: this.SCREEN_HEIGHT,
      };
    }

    return {
      x: dividerRight,
      y: 0,
      width: this.SCREEN_WIDTH - dividerRight,
      height: this.SCREEN_HEIGHT,
    };
  }

  private shouldCullBullet(bullet: Bullet): boolean {
    const screenHeight = this.SCREEN_HEIGHT;
    const viewport = this.getSideViewport(bullet.side);

    if (bullet.y + bullet.height < 0 || bullet.y > screenHeight) {
      return true;
    }

    return bullet.x < viewport.x || bullet.x + bullet.width > viewport.x + viewport.width;
  }

  hasActiveEnemies(): boolean {
    return this.enemies.some(e => e.active);
  }

  private updateGameOverState() {
    console.log('[Game] updateGameOverState check', { gameOver: this.gameOver, player1Health: this.player1?.health, player2Health: this.player2 ? this.player2.health : null });

    if (this.gameOver) {
      return;
    }

    if (this.player1.health <= 0 && this.player2 && this.player2.health <= 0) {
      this.gameOver = true;
      this.winnerText = '平局';
      try {
        this.downloadTrainingEvents('jsonl');
      } catch (_) {}
      return;
    }

    if (this.player1.health <= 0) {
      this.gameOver = true;
      this.winnerText = this.gameMode === 'single' ? 'AI 获胜' : '右侧玩家获胜';
      try {
        this.downloadTrainingEvents('jsonl');
      } catch (_) {}
      return;
    }

    if (this.player2 && this.player2.health <= 0) {
      this.gameOver = true;
      this.winnerText = '左侧玩家获胜';
      try {
        this.downloadTrainingEvents('jsonl');
      } catch (_) {}
    }
  }

  isGameOver(): boolean {
    return this.gameOver;
  }

  getWinnerText(): string {
    return this.winnerText;
  }
  
  private setupEventListeners() {
    if (this.listenersAttached) {
      return;
    }
    window.addEventListener('keydown', this.keyDownListener);
    window.addEventListener('keyup', this.keyUpListener);
    this.listenersAttached = true;
  }

  private removeEventListeners() {
    if (!this.listenersAttached) {
      return;
    }
    window.removeEventListener('keydown', this.keyDownListener);
    window.removeEventListener('keyup', this.keyUpListener);
    this.listenersAttached = false;
  }
  
  private handleKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowLeft':
        this.player1.movingLeft = true;
        break;
      case 'ArrowRight':
        this.player1.movingRight = true;
        break;
      case 'ArrowUp':
        this.player1.movingUp = true;
        break;
      case 'ArrowDown':
        this.player1.movingDown = true;
        break;
      case 'z':
      case 'Z':
        if (e.repeat) break;
        this.player1.startCharging();
        break;
      case 'x':
      case 'X':
        this.player1.useBomb(this);
        break;
      case 'Shift':
        if (this.gameMode === 'single') {
          this.player1.setFocusMode(true);
        }
        break;
    }
    
    if (this.player2) {
      switch (e.key) {
        case 'a':
        case 'A':
          this.player2.movingLeft = true;
          break;
        case 'd':
        case 'D':
          this.player2.movingRight = true;
          break;
        case 'w':
        case 'W':
          this.player2.movingUp = true;
          break;
        case 's':
        case 'S':
          this.player2.movingDown = true;
          break;
        case 'j':
        case 'J':
          if (e.repeat) break;
          this.player2.startCharging();
          break;
        case 'k':
        case 'K':
          this.player2.useBomb(this);
          break;
      }
    }
  }
  
  private handleKeyUp(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowLeft':
        this.player1.movingLeft = false;
        break;
      case 'ArrowRight':
        this.player1.movingRight = false;
        break;
      case 'ArrowUp':
        this.player1.movingUp = false;
        break;
      case 'ArrowDown':
        this.player1.movingDown = false;
        break;
      case 'z':
      case 'Z':
        this.player1.releaseCharge(this);
        break;
      case 'Shift':
        if (this.gameMode === 'single') {
          this.player1.setFocusMode(false);
        }
        break;
    }
    
    if (this.player2) {
      switch (e.key) {
        case 'a':
        case 'A':
          this.player2.movingLeft = false;
          break;
        case 'd':
        case 'D':
          this.player2.movingRight = false;
          break;
        case 'w':
        case 'W':
          this.player2.movingUp = false;
          break;
        case 's':
        case 'S':
          this.player2.movingDown = false;
          break;
        case 'j':
        case 'J':
          this.player2.releaseCharge(this);
          break;
      }
    }
  }
}
