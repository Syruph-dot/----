import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { File } from 'node:buffer';
import { loadPolicyFromFiles } from '../src/systems/policy/loaders';
import type { PolicySourceKind } from '../src/systems/policy/types';

type SmokeOptions = {
  dir: string;
  sourceKind: PolicySourceKind;
};

function getFlagValue(args: string[], flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return fallback;
  }
  return args[index + 1];
}

function parseOptions(argv: string[]): SmokeOptions {
  const dir = resolve(getFlagValue(argv, '--dir', '.'));
  const sourceKind = getFlagValue(argv, '--source', 'auto') as PolicySourceKind;
  return { dir, sourceKind };
}

function collectFiles(rootDir: string): File[] {
  const result: File[] = [];

  const visit = (currentDir: string, relativePrefix: string) => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = join(currentDir, entry.name);
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }

      const content = readFileSync(absolutePath);
      const mimeType = entry.name.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      result.push(new File([content], relativePath, { type: mimeType }));
    }
  };

  visit(rootDir, '');
  return result;
}

function createSyntheticObservation() {
  return {
    self: {
      pos: { x: 150, y: 420 },
      vel: { vx: 2, vy: 0 },
      health: 92,
      bombs: 2,
      isCharging: false,
      currentCharge: 14,
      chargeMax: 20,
      side: 'left' as const,
    },
    opponent: {
      pos: { x: 900, y: 430 },
      vel: { vx: -1, vy: 0 },
      health: 88,
      bombs: 1,
      isCharging: false,
      currentCharge: 6,
      chargeMax: 20,
      side: 'right' as const,
    },
    enemies: [],
    bullets: [],
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

async function main() {
  const argv = process.argv.slice(2);
  const { dir, sourceKind } = parseOptions(argv);
  const stats = statSync(dir);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${dir}`);
  }

  const files = collectFiles(dir);
  if (files.length === 0) {
    throw new Error(`No files found under ${dir}`);
  }

  const result = await loadPolicyFromFiles(files, sourceKind);
  const decision = await result.provider.decide(createSyntheticObservation() as any);

  console.log(JSON.stringify({
    dir,
    sourceKind,
    kind: result.kind,
    label: result.label,
    fileCount: files.length,
    decision,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});