from __future__ import annotations

import argparse
import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator

MOVE_LABELS = [
    'stay',
    'left',
    'right',
    'up',
    'down',
    'up-left',
    'up-right',
    'down-left',
    'down-right',
]
FIRE_LABELS = ['keepGun', 'stopGun']
SKILL_LABELS = ['none', 'skill1', 'skill2', 'skill3', 'skill4', 'bomb']
MAX_ENEMY_SLOTS = 8
MAX_BULLET_SLOTS = 12


def build_feature_names() -> list[str]:
    names: list[str] = ['side_left', 'side_right']
    names.extend([
        'self_x', 'self_y', 'self_vx', 'self_vy', 'self_health', 'self_bombs', 'self_current_charge', 'self_charge_max', 'self_is_charging',
        'opponent_x', 'opponent_y', 'opponent_vx', 'opponent_vy', 'opponent_health', 'opponent_bombs', 'opponent_current_charge', 'opponent_charge_max', 'opponent_is_charging',
        'boss_present', 'boss_x', 'boss_y', 'boss_width', 'boss_height', 'boss_health_ratio', 'boss_can_take_damage', 'boss_side_left', 'boss_side_right',
        'arena_screen_width', 'arena_screen_height', 'arena_margin', 'arena_current_threat', 'arena_nearby_bullet_count', 'arena_decision_interval_ms',
    ])

    for index in range(1, MAX_ENEMY_SLOTS + 1):
      slot = f'enemy_{index:02d}'
      names.extend([
          f'{slot}_present', f'{slot}_dx', f'{slot}_dy', f'{slot}_width', f'{slot}_height', f'{slot}_health_ratio',
      ])

    for index in range(1, MAX_BULLET_SLOTS + 1):
      slot = f'bullet_{index:02d}'
      names.extend([
          f'{slot}_present', f'{slot}_dx', f'{slot}_dy', f'{slot}_vx', f'{slot}_vy', f'{slot}_width', f'{slot}_height', f'{slot}_damage',
          f'{slot}_is_beam_like', f'{slot}_is_warning', f'{slot}_can_be_destroyed', f'{slot}_is_circular',
          f'{slot}_category_barrage', f'{slot}_category_player1', f'{slot}_category_player2',
      ])

    return names


FEATURE_NAMES = build_feature_names()


def safe_number(value: Any) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return 0.0


def safe_bool(value: Any) -> float:
    return 1.0 if value else 0.0


def side_one_hot(side: Any) -> tuple[float, float]:
    return (1.0, 0.0) if side == 'left' else (0.0, 1.0)


def bullet_category_one_hot(category: Any) -> tuple[float, float, float]:
    return (
        1.0 if category == 'barrage' else 0.0,
        1.0 if category == 'player1' else 0.0,
        1.0 if category == 'player2' else 0.0,
    )


def flatten_observation(observation: dict[str, Any]) -> list[float]:
    features: list[float] = []
    self_state = observation.get('self') or {}
    opponent = observation.get('opponent') or {}
    boss = observation.get('boss') or None
    arena = observation.get('arena') or {}
    screen = observation.get('screen') or {}

    side_left, side_right = side_one_hot(self_state.get('side'))
    features.extend([side_left, side_right])
    features.extend([
        safe_number(self_state.get('pos', {}).get('x')),
        safe_number(self_state.get('pos', {}).get('y')),
        safe_number(self_state.get('vel', {}).get('vx')),
        safe_number(self_state.get('vel', {}).get('vy')),
        safe_number(self_state.get('health')),
        safe_number(self_state.get('bombs')),
        safe_number(self_state.get('currentCharge')),
        safe_number(self_state.get('chargeMax')),
        safe_bool(self_state.get('isCharging')),
    ])

    features.extend([
        safe_number(opponent.get('pos', {}).get('x')),
        safe_number(opponent.get('pos', {}).get('y')),
        safe_number(opponent.get('vel', {}).get('vx')),
        safe_number(opponent.get('vel', {}).get('vy')),
        safe_number(opponent.get('health')),
        safe_number(opponent.get('bombs')),
        safe_number(opponent.get('currentCharge')),
        safe_number(opponent.get('chargeMax')),
        safe_bool(opponent.get('isCharging')),
    ])

    if boss:
        boss_left, boss_right = side_one_hot(boss.get('side'))
        max_health = max(1.0, safe_number(boss.get('maxHealth')))
        boss_health_ratio = safe_number(boss.get('health')) / max_health
        features.extend([
            1.0,
            safe_number(boss.get('pos', {}).get('x')),
            safe_number(boss.get('pos', {}).get('y')),
            safe_number(boss.get('width')),
            safe_number(boss.get('height')),
            boss_health_ratio,
            safe_bool(boss.get('canTakeDamage')),
            boss_left,
            boss_right,
        ])
    else:
        features.extend([0.0] * 9)

    features.extend([
        safe_number(screen.get('width')),
        safe_number(screen.get('height')),
        safe_number(screen.get('margin')),
        safe_number(arena.get('currentThreat')),
        safe_number(arena.get('nearbyBulletCount')),
        safe_number(arena.get('decisionIntervalMs')),
    ])

    self_pos = self_state.get('pos') or {}
    enemies = observation.get('enemies') or []
    for index in range(MAX_ENEMY_SLOTS):
        enemy = enemies[index] if index < len(enemies) else None
        if not enemy:
            features.extend([0.0] * 6)
            continue

        max_health = max(1.0, safe_number(enemy.get('maxHealth')) or 2.0)
        features.extend([
            1.0,
            safe_number(enemy.get('pos', {}).get('x')) - safe_number(self_pos.get('x')),
            safe_number(enemy.get('pos', {}).get('y')) - safe_number(self_pos.get('y')),
            safe_number(enemy.get('width')),
            safe_number(enemy.get('height')),
            safe_number(enemy.get('health')) / max_health,
        ])

    bullets = observation.get('bullets') or []
    for index in range(MAX_BULLET_SLOTS):
        bullet = bullets[index] if index < len(bullets) else None
        if not bullet:
            features.extend([0.0] * 15)
            continue

        category_barrage, category_player1, category_player2 = bullet_category_one_hot(bullet.get('category'))
        features.extend([
            1.0,
            safe_number(bullet.get('pos', {}).get('x')) - safe_number(self_pos.get('x')),
            safe_number(bullet.get('pos', {}).get('y')) - safe_number(self_pos.get('y')),
            safe_number(bullet.get('vel', {}).get('vx')),
            safe_number(bullet.get('vel', {}).get('vy')),
            safe_number(bullet.get('width')),
            safe_number(bullet.get('height')),
            safe_number(bullet.get('damage')),
            safe_bool(bullet.get('isBeamLike')),
            safe_bool(bullet.get('isWarning')),
            safe_bool(bullet.get('canBeDestroyed')),
            safe_bool(bullet.get('isCircular')),
            category_barrage,
            category_player1,
            category_player2,
        ])

    return features


def classify_move(event: dict[str, Any]) -> str:
    center = (event.get('playerCenter') or event.get('observation', {}).get('self', {}).get('pos') or {})
    target = (event.get('movementTarget') or {})
    dx = safe_number(target.get('x')) - safe_number(center.get('x'))
    dy = safe_number(target.get('y')) - safe_number(center.get('y'))
    dead_zone = 12.0

    if abs(dx) <= dead_zone and abs(dy) <= dead_zone:
        return 'stay'
    if abs(dx) > dead_zone and abs(dy) <= dead_zone:
        return 'left' if dx < 0 else 'right'
    if abs(dx) <= dead_zone and abs(dy) > dead_zone:
        return 'up' if dy < 0 else 'down'
    if dx < 0 and dy < 0:
        return 'up-left'
    if dx > 0 and dy < 0:
        return 'up-right'
    if dx < 0 and dy > 0:
        return 'down-left'
    return 'down-right'


def classify_fire(event: dict[str, Any]) -> str:
    fire_target_available = event.get('fireTargetAvailable')
    if fire_target_available is not None:
        return 'keepGun' if bool(fire_target_available) else 'stopGun'

    if event.get('fireBlockedReason') == 'noTarget':
        return 'stopGun'
    return 'stopGun' if event.get('fireDecision') == 'stopGun' else 'keepGun'


def classify_skill(event: dict[str, Any]) -> str:
    skill_executed = event.get('skillExecuted')
    skill_requested = event.get('skillRequested')
    if skill_executed in SKILL_LABELS:
        return str(skill_executed)
    if skill_requested in SKILL_LABELS:
        return str(skill_requested)
    return 'none'


@dataclass
class Sample:
    sample_id: str
    features: list[float]
    labels: dict[str, str]
    meta: dict[str, Any]


def read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with path.open('r', encoding='utf-8') as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def collect_input_files(inputs: list[str]) -> list[Path]:
    files: list[Path] = []
    seen: set[Path] = set()
    for raw_input in inputs:
        candidate = Path(raw_input)
        if candidate.is_dir():
            for file_path in candidate.rglob('*.jsonl'):
                if file_path not in seen:
                    seen.add(file_path)
                    files.append(file_path)
        elif candidate.is_file():
            if candidate not in seen:
                seen.add(candidate)
                files.append(candidate)
    return sorted(files)


def load_samples(inputs: list[str]) -> list[Sample]:
    samples: list[Sample] = []
    for file_path in collect_input_files(inputs):
        for index, event in enumerate(read_jsonl(file_path)):
            observation = event.get('observation')
            if not isinstance(observation, dict):
                continue
            features = flatten_observation(observation)
            sample_id = f"{event.get('match_id', file_path.stem)}:{event.get('episode', 0)}:{event.get('frame', index)}:{event.get('side', 'unknown')}"
            labels = {
                'move': classify_move(event),
                'fire': classify_fire(event),
                'skill': classify_skill(event),
            }
            samples.append(Sample(sample_id=sample_id, features=features, labels=labels, meta={
                'source_file': str(file_path),
                'match_id': event.get('match_id'),
                'episode': event.get('episode'),
                'frame': event.get('frame'),
                'side': event.get('side'),
                'seed': event.get('seed'),
            }))
    return samples


def split_samples(samples: list[Sample], val_ratio: float) -> tuple[list[Sample], list[Sample]]:
    train: list[Sample] = []
    val: list[Sample] = []
    for sample in samples:
      digest = hashlib.sha1(sample.sample_id.encode('utf-8')).hexdigest()
      score = int(digest[:8], 16) / 0xFFFFFFFF
      if score < val_ratio:
          val.append(sample)
      else:
          train.append(sample)

    if not val and len(samples) > 1:
        val.append(train.pop())

    return train, val


def write_jsonl(path: Path, samples: Iterable[Sample]) -> int:
    count = 0
    with path.open('w', encoding='utf-8') as handle:
        for sample in samples:
            handle.write(json.dumps({
                'sample_id': sample.sample_id,
                'features': sample.features,
                'labels': {
                    'move': MOVE_LABELS.index(sample.labels['move']),
                    'fire': FIRE_LABELS.index(sample.labels['fire']),
                    'skill': SKILL_LABELS.index(sample.labels['skill']),
                },
                'label_names': sample.labels,
                'meta': sample.meta,
            }, ensure_ascii=False) + '\n')
            count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description='Prepare a BC dataset from training JSONL logs.')
    parser.add_argument('--input', action='append', required=True, help='Input JSONL file or directory. Repeatable.')
    parser.add_argument('--output-dir', required=True, help='Directory to write the processed dataset.')
    parser.add_argument('--val-ratio', type=float, default=0.1, help='Validation split ratio (default: 0.1).')
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    samples = load_samples(args.input)
    train_samples, val_samples = split_samples(samples, max(0.0, min(0.9, float(args.val_ratio))))

    train_count = write_jsonl(output_dir / 'train.jsonl', train_samples)
    val_count = write_jsonl(output_dir / 'val.jsonl', val_samples)

    feature_count = len(FEATURE_NAMES)
    feature_sums = [0.0] * feature_count
    feature_sq_sums = [0.0] * feature_count
    for sample in train_samples or samples:
        for index, value in enumerate(sample.features):
            feature_sums[index] += value
            feature_sq_sums[index] += value * value

    baseline_count = len(train_samples or samples) or 1
    means = [total / baseline_count for total in feature_sums]
    stds = []
    for index in range(feature_count):
        variance = max(0.0, feature_sq_sums[index] / baseline_count - means[index] ** 2)
        stds.append(math.sqrt(variance) if variance > 1e-12 else 1.0)

    metadata = {
        'format': 'bc-dataset-v1',
        'feature_names': FEATURE_NAMES,
        'labels': {
            'move': MOVE_LABELS,
            'fire': FIRE_LABELS,
            'skill': SKILL_LABELS,
        },
        'counts': {
            'total': len(samples),
            'train': train_count,
            'val': val_count,
        },
        'split': {
            'val_ratio': float(args.val_ratio),
        },
        'normalization': {
            'mean': means,
            'std': stds,
        },
        'sources': sorted({sample.meta['source_file'] for sample in samples}),
    }
    with (output_dir / 'metadata.json').open('w', encoding='utf-8') as handle:
        json.dump(metadata, handle, ensure_ascii=False, indent=2)

    print(json.dumps({
        'output_dir': str(output_dir),
        'samples': len(samples),
        'train': train_count,
        'val': val_count,
        'feature_count': feature_count,
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()