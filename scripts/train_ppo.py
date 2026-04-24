"""
Self-play PPO fine-tuning for the aircraft battle AI.

Training pipeline (aligned with the modern STG doc):
  1. Warm-start from an existing BC policy JSON (bc-mlp-v1 format).
  2. Collect self-play episodes by driving the headless runner with the
     current policy, then reading the resulting JSONL logs.
  3. Compute per-step advantages using Generalised Advantage Estimation (GAE).
  4. Apply PPO-clip updates with an entropy bonus to maintain exploration.
  5. Repeat from step 2 for the requested number of PPO iterations.
  6. Export the improved policy in bc-mlp-v1 format (drop-in replacement).

Usage (after running the headless runner to collect initial BC data):

  # Warm-start from a BC policy, collect 4 self-play rollouts per iteration:
  python scripts/train_ppo.py \\
      --policy-in  training-output/policy.json \\
      --policy-out training-output/policy_ppo.json \\
      --rollout-dir /tmp/ppo-rollouts \\
      --ppo-iters 10 \\
      --episodes-per-iter 4 \\
      --epochs 4

  # The updated policy can then be loaded into the game via the UI or the
  # headless runner's --policy-left / --policy-right flags.

Notes:
  - Node.js and the pnpm scripts must be available on PATH for the subprocess
    calls that collect new episodes.  Set --no-subprocess to skip live rollout
    collection and train purely on pre-collected JSONL logs instead.
  - Requires: torch>=2.2  (numpy is bundled with torch)
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

try:
    import torch
    from torch import nn
    from torch.utils.data import DataLoader, TensorDataset
except ImportError as exc:
    raise SystemExit(
        'PyTorch is required.  Install via: pip install -r requirements-training.txt'
    ) from exc

# ---------------------------------------------------------------------------
# Action label definitions (must match featureLayout.ts)
# ---------------------------------------------------------------------------
MOVE_LABELS = [
    'stay', 'left', 'right', 'up', 'down',
    'up-left', 'up-right', 'down-left', 'down-right',
]
FIRE_LABELS = ['keepGun', 'stopGun']
SKILL_LABELS = ['none', 'skill1', 'skill2', 'skill3', 'skill4', 'bomb']

N_MOVE = len(MOVE_LABELS)
N_FIRE = len(FIRE_LABELS)
N_SKILL = len(SKILL_LABELS)


# ---------------------------------------------------------------------------
# Model (identical topology to train_bc.py's PolicyNet)
# ---------------------------------------------------------------------------
class PolicyNet(nn.Module):
    def __init__(self, input_size: int, hidden_sizes: list[int]) -> None:
        super().__init__()
        layers: list[nn.Module] = []
        prev = input_size
        for h in hidden_sizes:
            layers.append(nn.Linear(prev, h))
            layers.append(nn.ReLU())
            prev = h
        self.trunk = nn.Sequential(*layers)
        self.move_head = nn.Linear(prev, N_MOVE)
        self.fire_head = nn.Linear(prev, N_FIRE)
        self.skill_head = nn.Linear(prev, N_SKILL)

    def forward(self, x: torch.Tensor):
        h = self.trunk(x)
        return self.move_head(h), self.fire_head(h), self.skill_head(h)


# ---------------------------------------------------------------------------
# BC policy JSON helpers
# ---------------------------------------------------------------------------
def load_policy_json(path: Path) -> dict[str, Any]:
    with path.open('r', encoding='utf-8') as fh:
        return json.load(fh)


def build_model_from_spec(spec: dict[str, Any]) -> tuple[PolicyNet, int]:
    feature_names: list[str] = spec['featureNames']
    hidden_sizes: list[int] = spec.get('hiddenSizes', [256, 256])
    model = PolicyNet(len(feature_names), hidden_sizes)

    # Load trunk weights
    trunk_modules = [m for m in model.trunk if isinstance(m, nn.Linear)]
    for idx, layer_spec in enumerate(spec.get('trunk', [])):
        if idx >= len(trunk_modules):
            break
        layer = trunk_modules[idx]
        layer.weight.data = torch.tensor(layer_spec['weights'], dtype=torch.float32)
        layer.bias.data = torch.tensor(layer_spec['bias'], dtype=torch.float32)

    def _load_head(head: nn.Linear, head_spec: dict[str, Any]) -> None:
        head.weight.data = torch.tensor(head_spec['weights'], dtype=torch.float32)
        head.bias.data = torch.tensor(head_spec['bias'], dtype=torch.float32)

    _load_head(model.move_head, spec['heads']['move'])
    _load_head(model.fire_head, spec['heads']['fire'])
    _load_head(model.skill_head, spec['heads']['skill'])

    return model, len(feature_names)


def export_policy(
    path: Path,
    model: PolicyNet,
    spec: dict[str, Any],
    ppo_iters_done: int,
    metrics: dict[str, Any],
) -> None:
    trunk_layers = []
    for m in model.trunk:
        if isinstance(m, nn.Linear):
            trunk_layers.append({
                'weights': m.weight.detach().cpu().tolist(),
                'bias': m.bias.detach().cpu().tolist(),
            })

    def _head_spec(head: nn.Linear) -> dict[str, Any]:
        return {
            'weights': head.weight.detach().cpu().tolist(),
            'bias': head.bias.detach().cpu().tolist(),
        }

    out = {
        'format': 'bc-mlp-v1',
        'featureNames': spec['featureNames'],
        'hiddenSizes': spec.get('hiddenSizes', [256, 256]),
        'activation': 'relu',
        'outputLabels': spec['outputLabels'],
        'normalization': spec['normalization'],
        'trunk': trunk_layers,
        'heads': {
            'move': _head_spec(model.move_head),
            'fire': _head_spec(model.fire_head),
            'skill': _head_spec(model.skill_head),
        },
        'training': {
            **spec.get('training', {}),
            'ppoPolicyIters': ppo_iters_done,
        },
        'metrics': metrics,
    }
    with path.open('w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Feature normalisation (mirrors jsonPolicy.ts: normalizeFeatureVector)
# ---------------------------------------------------------------------------
def normalize(features: torch.Tensor, mean: torch.Tensor, std: torch.Tensor) -> torch.Tensor:
    return (features - mean) / std.clamp(min=1e-8)


# ---------------------------------------------------------------------------
# JSONL rollout loading
# ---------------------------------------------------------------------------
def classify_move(event: dict[str, Any]) -> int:
    center = (event.get('playerCenter') or
              event.get('observation', {}).get('self', {}).get('pos') or {})
    target = event.get('movementTarget') or {}
    dx = float(target.get('x', 0)) - float(center.get('x', 0))
    dy = float(target.get('y', 0)) - float(center.get('y', 0))
    dead = 12.0
    if abs(dx) <= dead and abs(dy) <= dead:
        return MOVE_LABELS.index('stay')
    if abs(dx) > dead and abs(dy) <= dead:
        return MOVE_LABELS.index('left' if dx < 0 else 'right')
    if abs(dx) <= dead and abs(dy) > dead:
        return MOVE_LABELS.index('up' if dy < 0 else 'down')
    if dx < 0 and dy < 0:
        return MOVE_LABELS.index('up-left')
    if dx > 0 and dy < 0:
        return MOVE_LABELS.index('up-right')
    if dx < 0 and dy > 0:
        return MOVE_LABELS.index('down-left')
    return MOVE_LABELS.index('down-right')


def classify_fire(event: dict[str, Any]) -> int:
    fd = event.get('fireDecision')
    if fd in FIRE_LABELS:
        return FIRE_LABELS.index(fd)
    if event.get('fireTargetAvailable'):
        return FIRE_LABELS.index('keepGun')
    return FIRE_LABELS.index('stopGun')


def classify_skill(event: dict[str, Any]) -> int:
    for key in ('skillExecuted', 'skillRequested'):
        v = event.get(key)
        if v in SKILL_LABELS:
            return SKILL_LABELS.index(v)
    return SKILL_LABELS.index('none')


def _safe(v: Any) -> float:
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    try:
        f = float(v)
        return f if math.isfinite(f) else 0.0
    except (TypeError, ValueError):
        return 0.0


def flatten_observation(obs: dict[str, Any]) -> list[float]:
    """Re-implementation of jsonPolicy.ts flattenObservation in Python."""
    MAX_ENEMY = 8
    MAX_BULLET = 12

    features: list[float] = []
    self_s = obs.get('self') or {}
    opp = obs.get('opponent') or {}
    boss = obs.get('boss') or None
    arena = obs.get('arena') or {}
    screen = obs.get('screen') or {}

    side = self_s.get('side', '')
    features += [1.0 if side == 'left' else 0.0, 0.0 if side == 'left' else 1.0]

    self_pos = self_s.get('pos', {}) or {}
    self_vel = self_s.get('vel', {}) or {}
    features += [
        _safe(self_pos.get('x')), _safe(self_pos.get('y')),
        _safe(self_vel.get('vx')), _safe(self_vel.get('vy')),
        _safe(self_s.get('health')), _safe(self_s.get('bombs')),
        _safe(self_s.get('currentCharge')), _safe(self_s.get('chargeMax')),
        1.0 if self_s.get('isCharging') else 0.0,
    ]

    opp_pos = opp.get('pos', {}) or {}
    opp_vel = opp.get('vel', {}) or {}
    features += [
        _safe(opp_pos.get('x')), _safe(opp_pos.get('y')),
        _safe(opp_vel.get('vx')), _safe(opp_vel.get('vy')),
        _safe(opp.get('health')), _safe(opp.get('bombs')),
        _safe(opp.get('currentCharge')), _safe(opp.get('chargeMax')),
        1.0 if opp.get('isCharging') else 0.0,
    ]

    if boss:
        boss_pos = boss.get('pos', {}) or {}
        boss_side = boss.get('side', '')
        max_h = max(1.0, _safe(boss.get('maxHealth')))
        features += [
            1.0, _safe(boss_pos.get('x')), _safe(boss_pos.get('y')),
            _safe(boss.get('width')), _safe(boss.get('height')),
            _safe(boss.get('health')) / max_h,
            1.0 if boss.get('canTakeDamage') else 0.0,
            1.0 if boss_side == 'left' else 0.0,
            0.0 if boss_side == 'left' else 1.0,
        ]
    else:
        features += [0.0] * 9

    features += [
        _safe(screen.get('width')), _safe(screen.get('height')),
        _safe(screen.get('margin')),
        _safe(arena.get('currentThreat')), _safe(arena.get('nearbyBulletCount')),
        _safe(arena.get('decisionIntervalMs')),
    ]

    sx = _safe(self_pos.get('x'))
    sy = _safe(self_pos.get('y'))
    enemies = obs.get('enemies') or []
    for i in range(MAX_ENEMY):
        e = enemies[i] if i < len(enemies) else None
        if not e:
            features += [0.0] * 6
            continue
        ep = e.get('pos', {}) or {}
        mh = max(1.0, _safe(e.get('maxHealth')) or 2.0)
        features += [
            1.0,
            _safe(ep.get('x')) - sx, _safe(ep.get('y')) - sy,
            _safe(e.get('width')), _safe(e.get('height')),
            _safe(e.get('health')) / mh,
        ]

    bullets = obs.get('bullets') or []
    for i in range(MAX_BULLET):
        b = bullets[i] if i < len(bullets) else None
        if not b:
            features += [0.0] * 15
            continue
        bp = b.get('pos', {}) or {}
        bv = b.get('vel', {}) or {}
        cat = b.get('category', '')
        features += [
            1.0,
            _safe(bp.get('x')) - sx, _safe(bp.get('y')) - sy,
            _safe(bv.get('vx')), _safe(bv.get('vy')),
            _safe(b.get('width')), _safe(b.get('height')),
            _safe(b.get('damage')),
            1.0 if b.get('isBeamLike') else 0.0,
            1.0 if b.get('isWarning') else 0.0,
            1.0 if b.get('canBeDestroyed') else 0.0,
            1.0 if b.get('isCircular') else 0.0,
            1.0 if cat == 'barrage' else 0.0,
            1.0 if cat == 'player1' else 0.0,
            1.0 if cat == 'player2' else 0.0,
        ]

    return features


# ---------------------------------------------------------------------------
# Reward shaping
# ---------------------------------------------------------------------------
def compute_reward(event: dict[str, Any], prev_event: dict[str, Any] | None) -> float:
    """
    Reward signal for the PPO update.

    Design rationale (mirrors PoDD-style resource/survival logic):
      + Alive bonus     : small constant per frame for staying alive
      + Score delta     : gain proportional to score increase this tick
      - Bomb penalty    : using a bomb carelessly costs a small reward
      + Survival bonus  : awarded retroactively at episode end if player wins
    """
    reward = 0.01  # alive bonus per tick

    obs = event.get('observation', {}) or {}
    self_state = obs.get('self', {}) or {}
    health = _safe(self_state.get('health'))
    reward += health / 1000.0  # proportional health retention

    # Score delta (use tickMetadata score if present)
    score_now = _safe(event.get('score', 0))
    score_prev = _safe((prev_event or {}).get('score', 0))
    reward += max(0.0, score_now - score_prev) * 0.002

    # Penalise bomb usage — save bombs for genuine emergencies (PoDD pattern)
    if event.get('skillExecuted') == 'bomb':
        reward -= 0.15

    return reward


def discount_cumsum(rewards: list[float], gamma: float) -> list[float]:
    running = 0.0
    result = []
    for r in reversed(rewards):
        running = r + gamma * running
        result.append(running)
    return list(reversed(result))


def gae_advantages(
    rewards: list[float],
    values: list[float],
    gamma: float = 0.99,
    lam: float = 0.95,
) -> tuple[list[float], list[float]]:
    """Generalised Advantage Estimation."""
    n = len(rewards)
    advantages = [0.0] * n
    returns = [0.0] * n
    gae = 0.0
    for t in reversed(range(n)):
        next_val = values[t + 1] if t + 1 < n else 0.0
        delta = rewards[t] + gamma * next_val - values[t]
        gae = delta + gamma * lam * gae
        advantages[t] = gae
        returns[t] = advantages[t] + values[t]
    return advantages, returns


# ---------------------------------------------------------------------------
# Episode collection via headless runner subprocess
# ---------------------------------------------------------------------------
def collect_episodes(
    policy_path: Path,
    rollout_dir: Path,
    episodes: int,
    max_frames: int,
    seed: str,
) -> list[Path]:
    """
    Launch the headless runner with the current policy on both sides and
    return the list of JSONL files written.
    """
    rollout_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        'pnpm', 'run', 'headless', '--',
        '--episodes', str(episodes),
        '--max-frames', str(max_frames),
        '--output-dir', str(rollout_dir),
        '--format', 'jsonl',
        '--split', 'none',
        '--mode', 'selfplay',
        '--policy-left', str(policy_path),
        '--policy-right', str(policy_path),
        '--seed', seed,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print('[PPO] headless runner stderr:', result.stderr[:2000], file=sys.stderr)
        raise RuntimeError(f'headless runner exited with code {result.returncode}')

    return sorted(rollout_dir.glob('*.jsonl'))


def load_rollout_events(jsonl_files: list[Path]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for path in jsonl_files:
        with path.open('r', encoding='utf-8') as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                    if isinstance(event.get('observation'), dict):
                        events.append(event)
                except json.JSONDecodeError:
                    pass
    return events


def build_trajectories(
    events: list[dict[str, Any]],
    model: PolicyNet,
    mean: torch.Tensor,
    std: torch.Tensor,
    device: torch.device,
    gamma: float = 0.99,
    lam: float = 0.95,
) -> dict[str, torch.Tensor]:
    """
    Convert raw JSONL events into PPO training tensors.

    Returns a dict with keys:
      features, move_actions, fire_actions, skill_actions,
      move_log_probs, fire_log_probs, skill_log_probs,
      advantages, returns
    """
    all_features: list[list[float]] = []
    all_move: list[int] = []
    all_fire: list[int] = []
    all_skill: list[int] = []
    all_rewards: list[float] = []

    prev: dict[str, Any] | None = None
    for event in events:
        obs = event.get('observation')
        if not isinstance(obs, dict):
            prev = event
            continue
        feat = flatten_observation(obs)
        all_features.append(feat)
        all_move.append(classify_move(event))
        all_fire.append(classify_fire(event))
        all_skill.append(classify_skill(event))
        all_rewards.append(compute_reward(event, prev))
        prev = event

    if not all_features:
        return {}

    feat_tensor = torch.tensor(all_features, dtype=torch.float32, device=device)
    feat_norm = normalize(feat_tensor, mean.to(device), std.to(device))

    model.eval()
    with torch.no_grad():
        move_logits, fire_logits, skill_logits = model(feat_norm)
        move_log_probs = torch.log_softmax(move_logits, dim=-1)
        fire_log_probs = torch.log_softmax(fire_logits, dim=-1)
        skill_log_probs = torch.log_softmax(skill_logits, dim=-1)

        # Use the mean of all head log-probs as a rough scalar value baseline.
        values_raw = (
            move_log_probs.max(dim=-1).values
            + fire_log_probs.max(dim=-1).values
            + skill_log_probs.max(dim=-1).values
        ) / 3.0
        values = values_raw.cpu().tolist()

    move_actions = torch.tensor(all_move, dtype=torch.long, device=device)
    fire_actions = torch.tensor(all_fire, dtype=torch.long, device=device)
    skill_actions = torch.tensor(all_skill, dtype=torch.long, device=device)

    old_move_lp = move_log_probs.gather(1, move_actions.unsqueeze(1)).squeeze(1)
    old_fire_lp = fire_log_probs.gather(1, fire_actions.unsqueeze(1)).squeeze(1)
    old_skill_lp = skill_log_probs.gather(1, skill_actions.unsqueeze(1)).squeeze(1)

    advantages, returns = gae_advantages(all_rewards, values, gamma=gamma, lam=lam)
    adv_t = torch.tensor(advantages, dtype=torch.float32, device=device)
    ret_t = torch.tensor(returns, dtype=torch.float32, device=device)
    # Normalise advantages for training stability.
    adv_t = (adv_t - adv_t.mean()) / (adv_t.std() + 1e-8)

    return {
        'features': feat_norm,
        'move_actions': move_actions,
        'fire_actions': fire_actions,
        'skill_actions': skill_actions,
        'old_move_lp': old_move_lp.detach(),
        'old_fire_lp': old_fire_lp.detach(),
        'old_skill_lp': old_skill_lp.detach(),
        'advantages': adv_t,
        'returns': ret_t,
    }


# ---------------------------------------------------------------------------
# PPO update step
# ---------------------------------------------------------------------------
def ppo_update(
    model: PolicyNet,
    optimizer: torch.optim.Optimizer,
    traj: dict[str, torch.Tensor],
    clip_eps: float = 0.2,
    entropy_coef: float = 0.01,
    batch_size: int = 256,
    epochs: int = 4,
    device: torch.device = torch.device('cpu'),
) -> dict[str, float]:
    n = traj['features'].shape[0]
    indices = torch.randperm(n, device=device)
    total_policy_loss = 0.0
    total_entropy = 0.0
    steps = 0

    for epoch in range(epochs):
        for start in range(0, n, batch_size):
            idx = indices[start:start + batch_size]

            feat = traj['features'][idx]
            move_a = traj['move_actions'][idx]
            fire_a = traj['fire_actions'][idx]
            skill_a = traj['skill_actions'][idx]
            old_mlp = traj['old_move_lp'][idx]
            old_flp = traj['old_fire_lp'][idx]
            old_slp = traj['old_skill_lp'][idx]
            adv = traj['advantages'][idx]

            move_logits, fire_logits, skill_logits = model(feat)

            def _ppo_head_loss(
                logits: torch.Tensor,
                actions: torch.Tensor,
                old_lp: torch.Tensor,
                advantages: torch.Tensor,
            ) -> tuple[torch.Tensor, torch.Tensor]:
                new_lp = torch.log_softmax(logits, dim=-1).gather(1, actions.unsqueeze(1)).squeeze(1)
                ratio = torch.exp(new_lp - old_lp)
                surr1 = ratio * advantages
                surr2 = torch.clamp(ratio, 1.0 - clip_eps, 1.0 + clip_eps) * advantages
                loss = -torch.min(surr1, surr2).mean()
                probs = torch.softmax(logits, dim=-1)
                entropy = -(probs * torch.log(probs + 1e-8)).sum(dim=-1).mean()
                return loss, entropy

            ml, me = _ppo_head_loss(move_logits, move_a, old_mlp, adv)
            fl, fe = _ppo_head_loss(fire_logits, fire_a, old_flp, adv)
            sl, se = _ppo_head_loss(skill_logits, skill_a, old_slp, adv)

            loss = ml + fl + sl - entropy_coef * (me + fe + se)

            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 0.5)
            optimizer.step()

            total_policy_loss += float(loss.item())
            total_entropy += float((me + fe + se).item()) / 3
            steps += 1

        # Re-shuffle indices each epoch
        indices = torch.randperm(n, device=device)

    denom = max(1, steps)
    return {
        'policy_loss': total_policy_loss / denom,
        'mean_entropy': total_entropy / denom,
        'samples': n,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Self-play PPO fine-tuning of a BC policy for the aircraft battle AI.'
    )
    parser.add_argument('--policy-in', required=True,
                        help='Input BC policy JSON (bc-mlp-v1 format).')
    parser.add_argument('--policy-out', required=True,
                        help='Output path for the PPO-improved policy JSON.')
    parser.add_argument('--rollout-dir', default='/tmp/ppo-rollouts',
                        help='Temporary directory for episode JSONL files (default: /tmp/ppo-rollouts).')
    parser.add_argument('--ppo-iters', type=int, default=10,
                        help='Number of PPO collect→update iterations (default: 10).')
    parser.add_argument('--episodes-per-iter', type=int, default=4,
                        help='Episodes to collect per PPO iteration (default: 4).')
    parser.add_argument('--max-frames', type=int, default=6000,
                        help='Max frames per episode for rollout collection (default: 6000).')
    parser.add_argument('--epochs', type=int, default=4,
                        help='PPO gradient epochs per iteration (default: 4).')
    parser.add_argument('--batch-size', type=int, default=256,
                        help='Mini-batch size for PPO update (default: 256).')
    parser.add_argument('--lr', type=float, default=3e-4,
                        help='Adam learning rate (default: 3e-4).')
    parser.add_argument('--clip-eps', type=float, default=0.2,
                        help='PPO clip epsilon (default: 0.2).')
    parser.add_argument('--entropy-coef', type=float, default=0.01,
                        help='Entropy regularisation coefficient (default: 0.01).')
    parser.add_argument('--gamma', type=float, default=0.99,
                        help='Discount factor (default: 0.99).')
    parser.add_argument('--lam', type=float, default=0.95,
                        help='GAE lambda (default: 0.95).')
    parser.add_argument('--seed', type=int, default=42,
                        help='Random seed (default: 42).')
    parser.add_argument('--device', default='auto', choices=['auto', 'cpu', 'cuda'],
                        help='Compute device (default: auto).')
    parser.add_argument('--no-subprocess', action='store_true',
                        help='Skip live rollout collection; train only on JSONL files already in --rollout-dir.')
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    torch.manual_seed(args.seed)
    if torch.cuda.is_available() and args.device in ('auto', 'cuda'):
        device = torch.device('cuda')
    else:
        device = torch.device('cpu')
    print(f'[PPO] device={device}')

    # Load the warm-start BC policy
    policy_in = Path(args.policy_in)
    spec = load_policy_json(policy_in)
    model, n_features = build_model_from_spec(spec)
    model.to(device)

    norm = spec['normalization']
    mean_t = torch.tensor(norm['mean'], dtype=torch.float32)
    std_t = torch.tensor(norm['std'], dtype=torch.float32)

    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    rollout_dir = Path(args.rollout_dir)
    policy_out = Path(args.policy_out)
    policy_out.parent.mkdir(parents=True, exist_ok=True)

    # Keep a temp file for the current policy so the runner can load it
    with tempfile.NamedTemporaryFile(
        mode='w', suffix='.json', delete=False, encoding='utf-8'
    ) as tmp_fh:
        tmp_policy_path = Path(tmp_fh.name)

    history: list[dict[str, Any]] = []

    for iteration in range(1, args.ppo_iters + 1):
        print(f'[PPO] iteration {iteration}/{args.ppo_iters}')

        # --- Step 1: Export current policy to temp file ---
        export_policy(tmp_policy_path, model, spec, iteration - 1, {})

        # --- Step 2: Collect self-play episodes ---
        iter_rollout_dir = rollout_dir / f'iter_{iteration:03d}'
        jsonl_files: list[Path] = []
        if not args.no_subprocess:
            try:
                jsonl_files = collect_episodes(
                    tmp_policy_path,
                    iter_rollout_dir,
                    episodes=args.episodes_per_iter,
                    max_frames=args.max_frames,
                    seed=f'ppo-{args.seed}-{iteration}',
                )
                print(f'[PPO]   collected {len(jsonl_files)} rollout file(s)')
            except Exception as exc:
                print(f'[PPO]   rollout collection failed ({exc}); skipping iteration', file=sys.stderr)
                continue
        else:
            # Use pre-existing files in rollout-dir
            jsonl_files = sorted(rollout_dir.glob('**/*.jsonl'))
            if not jsonl_files:
                print('[PPO]   no JSONL files found in rollout-dir; cannot train', file=sys.stderr)
                break
            print(f'[PPO]   using {len(jsonl_files)} existing JSONL file(s) (--no-subprocess)')

        # --- Step 3: Build trajectories ---
        events = load_rollout_events(jsonl_files)
        print(f'[PPO]   loaded {len(events)} decision events')
        if not events:
            print('[PPO]   no usable events; skipping iteration', file=sys.stderr)
            continue

        traj = build_trajectories(events, model, mean_t, std_t, device,
                                  gamma=args.gamma, lam=args.lam)
        if not traj:
            print('[PPO]   trajectory build returned empty; skipping', file=sys.stderr)
            continue

        # --- Step 4: PPO update ---
        model.train()
        update_metrics = ppo_update(
            model, optimizer, traj,
            clip_eps=args.clip_eps,
            entropy_coef=args.entropy_coef,
            batch_size=args.batch_size,
            epochs=args.epochs,
            device=device,
        )
        print(
            f'[PPO]   policy_loss={update_metrics["policy_loss"]:.4f} '
            f'entropy={update_metrics["mean_entropy"]:.4f} '
            f'samples={update_metrics["samples"]}'
        )
        history.append({'iteration': iteration, **update_metrics})

    # --- Final export ---
    export_policy(policy_out, model, spec, args.ppo_iters, {'history': history})
    print(f'[PPO] saved policy → {policy_out}')

    # Clean up temp file
    try:
        tmp_policy_path.unlink()
    except OSError:
        pass

    print(json.dumps({
        'policy_out': str(policy_out),
        'ppo_iters': args.ppo_iters,
        'device': str(device),
        'history': history,
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
