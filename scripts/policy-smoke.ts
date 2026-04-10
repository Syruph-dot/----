import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JsonPolicyAdapter, createDefaultPolicySpec } from '../src/systems/policy/jsonPolicy';
import type { BCPolicySpec } from '../src/systems/policy/types';

function getFlagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return null;
  }
  return args[index + 1];
}

function createSyntheticObservation(): Parameters<JsonPolicyAdapter['decide']>[0] {
  return {
    self: {
      pos: { x: 150, y: 420 },
      vel: { vx: 2, vy: 0 },
      health: 92,
      bombs: 2,
      isCharging: false,
      currentCharge: 14,
      chargeMax: 20,
      side: 'left',
    },
    opponent: {
      pos: { x: 900, y: 430 },
      vel: { vx: -1, vy: 0 },
      health: 88,
      bombs: 1,
      isCharging: false,
      currentCharge: 6,
      chargeMax: 20,
      side: 'right',
    },
    enemies: [
      { pos: { x: 220, y: 180 }, width: 96, height: 96, health: 2, maxHealth: 2 },
      { pos: { x: 320, y: 220 }, width: 96, height: 96, health: 1, maxHealth: 2 },
    ],
    bullets: [
      {
        pos: { x: 180, y: 360 },
        vel: { vx: 0, vy: 6 },
        width: 6,
        height: 16,
        damage: 10,
        category: 'barrage',
        bulletType: 'normal',
        side: 'right',
        isBeamLike: false,
        isWarning: false,
        canBeDestroyed: true,
        isCircular: false,
      },
      {
        pos: { x: 700, y: 150 },
        vel: { vx: 0, vy: 4 },
        width: 4,
        height: 10,
        damage: 8,
        category: 'player2',
        bulletType: 'special',
        side: 'right',
        isBeamLike: false,
        isWarning: false,
        canBeDestroyed: false,
        isCircular: false,
      },
    ],
    boss: null,
    arena: {
      currentThreat: 1.5,
      nearbyBulletCount: 1,
      decisionIntervalMs: 120,
    },
    screen: {
      width: 1200,
      height: 800,
      margin: 0.1,
    },
    tick_ms: Date.now(),
    decision_interval_ms: 120,
  };
}

function loadPolicySpec(policyPath: string | null): BCPolicySpec {
  if (!policyPath) {
    return createDefaultPolicySpec();
  }

  const resolved = resolve(policyPath);
  const raw = readFileSync(resolved, 'utf-8');
  return JSON.parse(raw) as BCPolicySpec;
}

function main() {
  const argv = process.argv.slice(2);
  const policyPath = getFlagValue(argv, '--policy');
  const spec = loadPolicySpec(policyPath);
  const adapter = new JsonPolicyAdapter(spec);
  const observation = createSyntheticObservation();
  const decision = adapter.decide(observation);

  console.log(JSON.stringify({
    policyPath: policyPath ?? 'default-zero-policy',
    featureCount: spec.featureNames.length,
    decision,
  }, null, 2));
}

main();