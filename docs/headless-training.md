# Headless Training

Use the headless runner to generate self-play training data without opening the browser UI.

## Install

```bash
pnpm install
```

## Run

```bash
pnpm run headless -- --episodes 10 --output-dir training-output --format jsonl --split rare-full
```

## Batch Evolution

Use the batch orchestrator to evaluate and rank multiple candidate configurations across generations.

```bash
pnpm run evolve -- --generations 5 --population 8 --episodes 3 --output-dir evolution-output --format jsonl --split rare-full
```

Batch output includes:

- `batch-manifest.jsonl`: one record per episode with the full candidate and fitness data.
- `batch-summary.json`: one aggregated summary per generation plus the run options.
- Per-candidate episode exports under `generation-XX/<candidate-id>/`.

## Options

- `--episodes <n>`: number of episodes to simulate.
- `--max-frames <n>`: maximum frames per episode before truncation.
- `--output-dir <path>`: directory for exported files.
- `--format <jsonl|csv>`: export format.
- `--split <none|rare-full>`: emit a second rare-only file when set to `rare-full`.
- `--mode <single|dual|selfplay>`: match mode.
- `--difficulty <easy|normal|hard>`: AI difficulty.
- `--p1 <scatter|laser|tracking>`: left aircraft type.
- `--p2 <scatter|laser|tracking>`: right aircraft type.
- `--seed <value>`: base seed for reproducible runs.

## Output

Each episode writes files named like `matchId_seed-<seed>_<timestamp>_full.jsonl` into the output directory. When `--split rare-full` is enabled, a second rare-only file is emitted alongside the full export.

The batch orchestrator writes the same per-episode exports, but groups them by generation and candidate so you can trace selection and mutation history.

## Neural Network Spec

If you want to train a policy model on top of these logs, use [docs/nn-training-spec.md](docs/nn-training-spec.md) for the recommended input features, action heads, and reward design.

## BC Export and Runtime Policy

The current codebase includes a minimal end-to-end BC pipeline:

```bash
python scripts/prepare_bc_dataset.py --input training-output --output-dir bc-dataset
python scripts/train_bc.py --dataset-dir bc-dataset --output-dir bc-model
pnpm run policy:smoke -- --policy bc-model/policy.json
```

The trained `policy.json` can be loaded by `src/main.ts` in the browser start menu or passed programmatically through `GameConfig.agentPolicies`.

## Native Model Loading

Native loaders now support two runtime formats:

1. `ONNX native`: a `.onnx` file plus `policy.meta.json`, or reuse the exported `policy.json` as the shared manifest.
2. `TFJS native`: a `model.json` plus weight shards plus `policy.meta.json`, or reuse the exported `policy.json` as the shared manifest.

You can validate either path with:

```bash
pnpm run policy:native-smoke -- --source onnx --dir <native-model-folder>
pnpm run policy:native-smoke -- --source tfjs --dir <native-model-folder>
```

## Native Model Loading

The runtime now supports three policy sources:

1. `JSON policy`: the BC export produced by `scripts/train_bc.py`.
2. `ONNX native`: a `.onnx` model plus either `policy.meta.json` or the existing `policy.json` as shared metadata.
3. `TFJS native`: a `model.json` + weight shards plus either `policy.meta.json` or the existing `policy.json` as shared metadata.

In the browser start menu, choose the policy type first and then select the files. The loader will reuse the same feature order and action labels across all three formats.
