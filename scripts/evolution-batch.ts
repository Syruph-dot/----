import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Game } from '../src/core/Game';
import { createHeadlessRuntimeAdapter } from '../src/runtime/headlessRuntime';
import type { AircraftType, Difficulty, GameMode, PlayerSide } from '../src/entities/types';

type CandidateConfig = {
  mode: GameMode;
  difficulty: Difficulty;
  player1Aircraft: AircraftType;
  player2Aircraft: AircraftType;
  seed: string;
};

type CandidateSpec = {
  id: string;
  generation: number;
  parentId?: string;
  config: CandidateConfig;
};

type EpisodeRecord = {
  generation: number;
  candidateId: string;
  parentId?: string;
  episodeIndex: number;
  seed: string;
  frames: number;
  truncated: boolean;
  winnerText: string;
  gameOver: boolean;
  fitness: number;
  rareEvents: number;
  files: string[];
  summary: ReturnType<Game['getMatchSummary']>;
};

type CandidateResult = {
  candidateId: string;
  generation: number;
  parentId?: string;
  config: CandidateConfig;
  episodeCount: number;
  averageFitness: number;
  averageCombinedScore: number;
  averageRareEvents: number;
  averageFrames: number;
  winCount: number;
  truncatedCount: number;
  episodeRecords: EpisodeRecord[];
};

type BatchOptions = {
  generations: number;
  population: number;
  episodesPerCandidate: number;
  maxFrames: number;
  outputDir: string;
  format: 'jsonl' | 'csv';
  split: 'none' | 'rare-full';
  mode: GameMode;
  difficulty: Difficulty;
  player1Aircraft: AircraftType;
  player2Aircraft: AircraftType;
  seed: string;
  eliteRatio: number;
  mutationRate: number;
};

const AIRCRAFT_TYPES: AircraftType[] = ['scatter', 'laser', 'tracking'];
const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard'];

function parseFlag(args: string[], flag: string, defaultValue: string) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return defaultValue;
  }

  return args[index + 1];
}

function parseInteger(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseFloatValue(value: string, fallback: number) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeRatio(value: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, value));
}

function createRng(seedText: string) {
  let state = 0x811c9dc5;
  for (let index = 0; index < seedText.length; index += 1) {
    state ^= seedText.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }

  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickRandom<T>(values: T[], rng: () => number): T {
  return values[Math.floor(rng() * values.length) % values.length];
}

function sanitizeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function parseOptions(argv: string[]): BatchOptions {
  const generations = parseInteger(parseFlag(argv, '--generations', '3'), 3);
  const population = parseInteger(parseFlag(argv, '--population', '6'), 6);
  const episodesPerCandidate = parseInteger(parseFlag(argv, '--episodes', '2'), 2);
  const maxFrames = parseInteger(parseFlag(argv, '--max-frames', '6000'), 6000);
  const outputDir = resolve(parseFlag(argv, '--output-dir', 'evolution-output'));
  const format = parseFlag(argv, '--format', 'jsonl') as 'jsonl' | 'csv';
  const split = parseFlag(argv, '--split', 'rare-full') as 'none' | 'rare-full';
  const mode = parseFlag(argv, '--mode', 'selfplay') as GameMode;
  const difficulty = parseFlag(argv, '--difficulty', 'normal') as Difficulty;
  const player1Aircraft = parseFlag(argv, '--p1', 'scatter') as AircraftType;
  const player2Aircraft = parseFlag(argv, '--p2', 'scatter') as AircraftType;
  const seed = parseFlag(argv, '--seed', `${Date.now()}`);
  const eliteRatio = normalizeRatio(parseFloatValue(parseFlag(argv, '--elite-ratio', '0.25'), 0.25), 0.25);
  const mutationRate = normalizeRatio(parseFloatValue(parseFlag(argv, '--mutation-rate', '0.35'), 0.35), 0.35);

  return {
    generations,
    population,
    episodesPerCandidate,
    maxFrames,
    outputDir,
    format,
    split,
    mode,
    difficulty,
    player1Aircraft,
    player2Aircraft,
    seed,
    eliteRatio,
    mutationRate,
  };
}

function printUsage() {
  console.log([
    'Usage: pnpm run evolve -- [options]',
    '',
    'Options:',
    '  --generations <n>    Number of generations to evaluate (default: 3)',
    '  --population <n>     Candidates per generation (default: 6)',
    '  --episodes <n>       Episodes per candidate (default: 2)',
    '  --max-frames <n>     Maximum frames per episode (default: 6000)',
    '  --output-dir <path>  Root directory for batch artifacts (default: evolution-output)',
    '  --format <jsonl|csv> Episode export format (default: jsonl)',
    '  --split <none|rare-full>  Whether to emit rare-only exports (default: rare-full)',
    '  --mode <single|dual|selfplay> Match mode (default: selfplay)',
    '  --difficulty <easy|normal|hard> Base AI difficulty (default: normal)',
    '  --p1 <scatter|laser|tracking>  Base left aircraft (default: scatter)',
    '  --p2 <scatter|laser|tracking>  Base right aircraft (default: scatter)',
    '  --seed <value>       Base seed string (default: current timestamp)',
    '  --elite-ratio <0-1>   Survivor ratio per generation (default: 0.25)',
    '  --mutation-rate <0-1> Per-field mutation chance (default: 0.35)',
  ].join('\n'));
}

function mutateCandidateConfig(base: CandidateConfig, rng: () => number, options: BatchOptions): CandidateConfig {
  const next: CandidateConfig = { ...base };

  if (rng() < options.mutationRate) {
    next.player1Aircraft = pickRandom(AIRCRAFT_TYPES, rng);
  }

  if (rng() < options.mutationRate) {
    next.player2Aircraft = pickRandom(AIRCRAFT_TYPES, rng);
  }

  if (rng() < options.mutationRate) {
    next.difficulty = pickRandom(DIFFICULTIES, rng);
  }

  if (rng() < options.mutationRate * 0.5) {
    next.mode = options.mode;
  }

  next.seed = `${base.seed}-${Math.floor(rng() * 1e9).toString(36)}`;
  return next;
}

function createInitialPopulation(options: BatchOptions, rng: () => number): CandidateSpec[] {
  const population: CandidateSpec[] = [];
  for (let index = 0; index < options.population; index += 1) {
    const config: CandidateConfig = {
      mode: options.mode,
      difficulty: index === 0 ? options.difficulty : pickRandom(DIFFICULTIES, rng),
      player1Aircraft: index === 0 ? options.player1Aircraft : pickRandom(AIRCRAFT_TYPES, rng),
      player2Aircraft: index === 0 ? options.player2Aircraft : pickRandom(AIRCRAFT_TYPES, rng),
      seed: `${options.seed}-g1-c${index + 1}`,
    };

    population.push({
      id: `g1-c${index + 1}`,
      generation: 1,
      config,
    });
  }

  return population;
}

function fitnessFromSummary(summary: ReturnType<Game['getMatchSummary']>, rareEvents: number, maxFrames: number) {
  const leftScore = summary.left.totalScore + summary.left.comboScore;
  const rightScore = summary.right.totalScore + summary.right.comboScore;
  const combinedScore = leftScore + rightScore;
  const winBonus = summary.winnerText.includes('获胜') ? 200 : 75;
  const gameOverBonus = summary.gameOver ? 150 : 0;
  const rareBonus = rareEvents * 10;
  const frameBonus = Math.min(summary.frames, maxFrames) * 0.35;
  const durationPenalty = summary.durationMs * 0.01;

  return combinedScore + winBonus + gameOverBonus + rareBonus + frameBonus - durationPenalty;
}

function buildCandidateOutputDir(rootOutputDir: string, generation: number, candidateId: string) {
  return resolve(rootOutputDir, `generation-${String(generation).padStart(2, '0')}`, sanitizeSegment(candidateId));
}

function evaluateCandidate(candidate: CandidateSpec, options: BatchOptions): CandidateResult {
  const episodeRecords: EpisodeRecord[] = [];
  const candidateOutputDir = buildCandidateOutputDir(options.outputDir, candidate.generation, candidate.id);
  mkdirSync(candidateOutputDir, { recursive: true });

  let fitnessTotal = 0;
  let combinedScoreTotal = 0;
  let rareEventsTotal = 0;
  let framesTotal = 0;
  let winCount = 0;
  let truncatedCount = 0;

  for (let episodeIndex = 0; episodeIndex < options.episodesPerCandidate; episodeIndex += 1) {
    const episodeSeed = `${candidate.config.seed}-e${episodeIndex + 1}`;
    const runtime = createHeadlessRuntimeAdapter({
      outputDir: candidateOutputDir,
      startTime: Date.now() + candidate.generation * 1000 + episodeIndex,
    });

    const game = new Game(null, {
      mode: candidate.config.mode,
      difficulty: candidate.config.difficulty,
      player1Aircraft: candidate.config.player1Aircraft,
      player2Aircraft: candidate.config.player2Aircraft,
      seed: episodeSeed,
      headless: true,
      runtime,
      agentIds: {
        left: `${candidate.id}-left`,
        right: `${candidate.id}-right`,
      },
      trainingConfig: {
        source: 'evolution-batch',
        batchRoot: options.outputDir,
        generation: candidate.generation,
        candidateId: candidate.id,
        parentId: candidate.parentId ?? null,
        episodeIndex: episodeIndex + 1,
        episodesPerCandidate: options.episodesPerCandidate,
        maxFrames: options.maxFrames,
        eliteRatio: options.eliteRatio,
        mutationRate: options.mutationRate,
      },
    });

    game.start();

    const fixedDeltaTime = 1000 / 60;
    let frames = 0;
    while (!game.isGameOver() && frames < options.maxFrames) {
      game.step(fixedDeltaTime);
      frames += 1;
    }

    const truncated = !game.isGameOver();
    if (truncated) {
      game.pushTrainingEvent({
        game_event: 'episode_truncated',
        frame: frames,
        ts: Date.now(),
        side: 'left' as PlayerSide,
        seed: episodeSeed,
        candidateId: candidate.id,
        generation: candidate.generation,
      });
    }

    const summary = game.getMatchSummary();
    const rareEvents = game.getRareTrainingEvents().length;
    const files = game.flushTrainingEventsToDownload({
      format: options.format,
      split: options.split,
      clearAfterFlush: true,
    });
    const fitness = fitnessFromSummary(summary, rareEvents, options.maxFrames);

    fitnessTotal += fitness;
    combinedScoreTotal += summary.left.totalScore + summary.right.totalScore + summary.left.comboScore + summary.right.comboScore;
    rareEventsTotal += rareEvents;
    framesTotal += frames;
    if (summary.winnerText.includes('获胜')) {
      winCount += 1;
    }
    if (truncated) {
      truncatedCount += 1;
    }

    episodeRecords.push({
      generation: candidate.generation,
      candidateId: candidate.id,
      parentId: candidate.parentId,
      episodeIndex: episodeIndex + 1,
      seed: episodeSeed,
      frames,
      truncated,
      winnerText: game.getWinnerText(),
      gameOver: game.isGameOver(),
      fitness,
      rareEvents,
      files,
      summary,
    });

    console.log([
      `gen=${candidate.generation}`,
      `candidate=${candidate.id}`,
      `episode=${episodeIndex + 1}/${options.episodesPerCandidate}`,
      `frames=${frames}`,
      `fitness=${fitness.toFixed(2)}`,
      `winner=${game.getWinnerText() || 'n/a'}`,
      `files=${files.join(', ')}`,
    ].join(' | '));

    game.destroy();
  }

  const episodeCount = Math.max(1, options.episodesPerCandidate);
  return {
    candidateId: candidate.id,
    generation: candidate.generation,
    parentId: candidate.parentId,
    config: candidate.config,
    episodeCount,
    averageFitness: fitnessTotal / episodeCount,
    averageCombinedScore: combinedScoreTotal / episodeCount,
    averageRareEvents: rareEventsTotal / episodeCount,
    averageFrames: framesTotal / episodeCount,
    winCount,
    truncatedCount,
    episodeRecords,
  };
}

function breedNextGeneration(results: CandidateResult[], generation: number, options: BatchOptions, rng: () => number): CandidateSpec[] {
  const survivorCount = Math.max(1, Math.min(results.length, Math.round(results.length * options.eliteRatio)));
  const survivors = results.slice().sort((left, right) => right.averageFitness - left.averageFitness).slice(0, survivorCount);
  const nextPopulation: CandidateSpec[] = [];

  for (let index = 0; index < options.population; index += 1) {
    const parent = survivors[index % survivors.length];
    const config = mutateCandidateConfig(parent.config, rng, options);
    nextPopulation.push({
      id: `g${generation}-c${index + 1}`,
      generation,
      parentId: parent.candidateId,
      config,
    });
  }

  return nextPopulation;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return;
  }

  const options = parseOptions(argv);
  mkdirSync(options.outputDir, { recursive: true });

  const rng = createRng(options.seed);
  let currentPopulation = createInitialPopulation(options, rng);
  const allCandidateResults: CandidateResult[] = [];
  const episodeManifestLines: string[] = [];
  const generationSummaries: Array<{
    generation: number;
    bestCandidateId: string;
    bestFitness: number;
    averageFitness: number;
    averageCombinedScore: number;
    averageRareEvents: number;
  }> = [];

  for (let generation = 1; generation <= options.generations; generation += 1) {
    const generationResults: CandidateResult[] = [];

    for (const candidate of currentPopulation) {
      const result = evaluateCandidate(candidate, options);
      generationResults.push(result);
      allCandidateResults.push(result);

      for (const episodeRecord of result.episodeRecords) {
        episodeManifestLines.push(JSON.stringify(episodeRecord));
      }
    }

    generationResults.sort((left, right) => right.averageFitness - left.averageFitness);
    const averageFitness = generationResults.reduce((sum, result) => sum + result.averageFitness, 0) / Math.max(1, generationResults.length);
    const averageCombinedScore = generationResults.reduce((sum, result) => sum + result.averageCombinedScore, 0) / Math.max(1, generationResults.length);
    const averageRareEvents = generationResults.reduce((sum, result) => sum + result.averageRareEvents, 0) / Math.max(1, generationResults.length);
    const bestCandidate = generationResults[0];

    generationSummaries.push({
      generation,
      bestCandidateId: bestCandidate.candidateId,
      bestFitness: bestCandidate.averageFitness,
      averageFitness,
      averageCombinedScore,
      averageRareEvents,
    });

    console.log([
      `generation ${generation}/${options.generations}`,
      `best=${bestCandidate.candidateId}`,
      `fitness=${bestCandidate.averageFitness.toFixed(2)}`,
      `avgFitness=${averageFitness.toFixed(2)}`,
      `avgScore=${averageCombinedScore.toFixed(2)}`,
      `avgRare=${averageRareEvents.toFixed(2)}`,
    ].join(' | '));

    if (generation < options.generations) {
      currentPopulation = breedNextGeneration(generationResults, generation + 1, options, rng);
    }
  }

  const summaryPath = resolve(options.outputDir, 'batch-summary.json');
  const manifestPath = resolve(options.outputDir, 'batch-manifest.jsonl');
  writeFileSync(summaryPath, JSON.stringify({
    options,
    generations: generationSummaries,
    candidateCount: allCandidateResults.length,
  }, null, 2), 'utf8');
  writeFileSync(manifestPath, `${episodeManifestLines.join('\n')}${episodeManifestLines.length > 0 ? '\n' : ''}`, 'utf8');

  console.log(`wrote ${allCandidateResults.length} candidate result(s) to ${options.outputDir}`);
  console.log(`summary: ${summaryPath}`);
  console.log(`manifest: ${manifestPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
