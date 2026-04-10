import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Game } from '../src/core/Game';
import { createHeadlessRuntimeAdapter } from '../src/runtime/headlessRuntime';
import type { AircraftType, Difficulty, GameMode } from '../src/entities/types';

type HeadlessRunOptions = {
  episodes: number;
  maxFrames: number;
  outputDir: string;
  format: 'jsonl' | 'csv';
  split: 'none' | 'rare-full';
  mode: GameMode;
  difficulty: Difficulty;
  player1Aircraft: AircraftType;
  player2Aircraft: AircraftType;
  seed: string;
};

function getFlagValue(args: string[], flag: string, defaultValue: string) {
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

function parseOptions(argv: string[]): HeadlessRunOptions {
  const episodes = parseInteger(getFlagValue(argv, '--episodes', '1'), 1);
  const maxFrames = parseInteger(getFlagValue(argv, '--max-frames', '6000'), 6000);
  const outputDir = resolve(getFlagValue(argv, '--output-dir', 'training-output'));
  const format = (getFlagValue(argv, '--format', 'jsonl') as 'jsonl' | 'csv');
  const split = (getFlagValue(argv, '--split', 'rare-full') as 'none' | 'rare-full');
  const mode = (getFlagValue(argv, '--mode', 'selfplay') as GameMode);
  const difficulty = (getFlagValue(argv, '--difficulty', 'normal') as Difficulty);
  const player1Aircraft = (getFlagValue(argv, '--p1', 'scatter') as AircraftType);
  const player2Aircraft = (getFlagValue(argv, '--p2', 'scatter') as AircraftType);
  const seed = getFlagValue(argv, '--seed', `${Date.now()}`);

  return {
    episodes,
    maxFrames,
    outputDir,
    format,
    split,
    mode,
    difficulty,
    player1Aircraft,
    player2Aircraft,
    seed,
  };
}

function printUsage() {
  console.log([
    'Usage: pnpm run headless -- [options]',
    '',
    'Options:',
    '  --episodes <n>       Number of episodes to run (default: 1)',
    '  --max-frames <n>     Maximum frames per episode (default: 6000)',
    '  --output-dir <path>  Where to write training files (default: training-output)',
    '  --format <jsonl|csv> Export format (default: jsonl)',
    '  --split <none|rare-full>  Whether to emit a rare-only file too (default: rare-full)',
    '  --mode <single|dual|selfplay>  Game mode (default: selfplay)',
    '  --difficulty <easy|normal|hard> AI difficulty (default: normal)',
    '  --p1 <scatter|laser|tracking>  Left aircraft (default: scatter)',
    '  --p2 <scatter|laser|tracking>  Right aircraft (default: scatter)',
    '  --seed <value>       Base seed string (default: current timestamp)',
  ].join('\n'));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return;
  }

  const options = parseOptions(argv);
  mkdirSync(options.outputDir, { recursive: true });

  const fixedDeltaTime = 1000 / 60;
  const summary: Array<{ episode: number; frames: number; gameOver: boolean; winner: string; files: string[] }> = [];

  for (let episodeIndex = 0; episodeIndex < options.episodes; episodeIndex += 1) {
    const seed = `${options.seed}-${episodeIndex + 1}`;
    const runtime = createHeadlessRuntimeAdapter({ outputDir: options.outputDir, startTime: Date.now() + episodeIndex });
    const game = new Game(null, {
      mode: options.mode,
      difficulty: options.difficulty,
      player1Aircraft: options.player1Aircraft,
      player2Aircraft: options.player2Aircraft,
      seed,
      headless: true,
      runtime,
      agentIds: {
        left: `headless-left-${episodeIndex + 1}`,
        right: `headless-right-${episodeIndex + 1}`,
      },
      trainingConfig: {
        source: 'headless-runner',
        episodeIndex: episodeIndex + 1,
        episodes: options.episodes,
        maxFrames: options.maxFrames,
        outputDir: options.outputDir,
        format: options.format,
        split: options.split,
      },
    });

    game.start();

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
        side: 'left',
        seed,
      });
    }

    const files = game.flushTrainingEventsToDownload({
      format: options.format,
      split: options.split,
      clearAfterFlush: true,
    });

    summary.push({
      episode: episodeIndex + 1,
      frames,
      gameOver: game.isGameOver(),
      winner: game.getWinnerText(),
      files,
    });

    console.log([
      `episode ${episodeIndex + 1}/${options.episodes}`,
      `frames=${frames}`,
      `gameOver=${game.isGameOver()}`,
      `winner=${game.getWinnerText() || 'n/a'}`,
      `files=${files.join(', ')}`,
    ].join(' | '));

    game.destroy();
  }

  console.log(`saved ${summary.length} episode(s) to ${options.outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
