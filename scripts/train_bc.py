from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

try:
    import torch
    from torch import nn
    from torch.utils.data import DataLoader, Dataset
except ImportError as exc:  # pragma: no cover - import guard for environments without torch
    raise SystemExit(
        'PyTorch is required for training. Install dependencies with `pip install -r requirements-training.txt`.'
    ) from exc


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


class JsonlBCDataset(Dataset):
    def __init__(self, dataset_path: Path) -> None:
        self.rows: list[dict[str, Any]] = []
        with dataset_path.open('r', encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                self.rows.append(json.loads(line))

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int):
        row = self.rows[index]
        features = torch.tensor(row['features'], dtype=torch.float32)
        labels = torch.tensor(
            [
                int(row['labels']['move']),
                int(row['labels']['fire']),
                int(row['labels']['skill']),
            ],
            dtype=torch.long,
        )
        return features, labels


class PolicyNet(nn.Module):
    def __init__(self, input_size: int, hidden_sizes: list[int]) -> None:
        super().__init__()
        layers: list[nn.Module] = []
        previous_size = input_size
        for hidden_size in hidden_sizes:
            layers.append(nn.Linear(previous_size, hidden_size))
            layers.append(nn.ReLU())
            previous_size = hidden_size
        self.trunk = nn.Sequential(*layers)
        self.move_head = nn.Linear(previous_size, len(MOVE_LABELS))
        self.fire_head = nn.Linear(previous_size, len(FIRE_LABELS))
        self.skill_head = nn.Linear(previous_size, len(SKILL_LABELS))

    def forward(self, features: torch.Tensor):
        hidden = self.trunk(features)
        return self.move_head(hidden), self.fire_head(hidden), self.skill_head(hidden)


def parse_int_list(raw_value: str) -> list[int]:
    values = [part.strip() for part in raw_value.split(',') if part.strip()]
    return [int(value) for value in values]


def load_metadata(dataset_dir: Path) -> dict[str, Any]:
    metadata_path = dataset_dir / 'metadata.json'
    if not metadata_path.exists():
        raise FileNotFoundError(f'Missing metadata file: {metadata_path}')
    with metadata_path.open('r', encoding='utf-8') as handle:
        return json.load(handle)


def load_dataset(dataset_dir: Path) -> tuple[JsonlBCDataset, JsonlBCDataset, dict[str, Any]]:
    metadata = load_metadata(dataset_dir)
    train_path = dataset_dir / 'train.jsonl'
    val_path = dataset_dir / 'val.jsonl'
    if not train_path.exists():
        raise FileNotFoundError(f'Missing training split: {train_path}')
    train_dataset = JsonlBCDataset(train_path)
    val_dataset = JsonlBCDataset(val_path) if val_path.exists() else JsonlBCDataset(train_path)
    if len(val_dataset) == 0:
        val_dataset = train_dataset
    return train_dataset, val_dataset, metadata


def build_model(input_size: int, hidden_sizes: list[int]) -> PolicyNet:
    return PolicyNet(input_size, hidden_sizes)


def batch_accuracy(logits: torch.Tensor, targets: torch.Tensor) -> float:
    predictions = logits.argmax(dim=1)
    return float((predictions == targets).float().mean().item()) if targets.numel() > 0 else 0.0


def run_epoch(
    model: PolicyNet,
    loader: DataLoader,
    optimizer: torch.optim.Optimizer | None,
    criterion: nn.Module,
    device: torch.device,
) -> dict[str, float]:
    training = optimizer is not None
    model.train(training)

    total_loss = 0.0
    total_samples = 0
    move_correct = 0.0
    fire_correct = 0.0
    skill_correct = 0.0

    for features, labels in loader:
        features = features.to(device)
        labels = labels.to(device)
        move_targets = labels[:, 0]
        fire_targets = labels[:, 1]
        skill_targets = labels[:, 2]

        if training:
            optimizer.zero_grad(set_to_none=True)

        move_logits, fire_logits, skill_logits = model(features)
        loss = criterion(move_logits, move_targets) + criterion(fire_logits, fire_targets) + criterion(skill_logits, skill_targets)

        if training:
            loss.backward()
            optimizer.step()

        batch_size = features.shape[0]
        total_loss += float(loss.item()) * batch_size
        total_samples += batch_size
        move_correct += float((move_logits.argmax(dim=1) == move_targets).float().sum().item())
        fire_correct += float((fire_logits.argmax(dim=1) == fire_targets).float().sum().item())
        skill_correct += float((skill_logits.argmax(dim=1) == skill_targets).float().sum().item())

    if total_samples == 0:
        return {
            'loss': 0.0,
            'move_acc': 0.0,
            'fire_acc': 0.0,
            'skill_acc': 0.0,
        }

    return {
        'loss': total_loss / total_samples,
        'move_acc': move_correct / total_samples,
        'fire_acc': fire_correct / total_samples,
        'skill_acc': skill_correct / total_samples,
    }


def linear_spec(layer: nn.Linear) -> dict[str, Any]:
    return {
        'weights': layer.weight.detach().cpu().tolist(),
        'bias': layer.bias.detach().cpu().tolist(),
    }


def export_policy(
    output_path: Path,
    model: PolicyNet,
    metadata: dict[str, Any],
    hidden_sizes: list[int],
    args: argparse.Namespace,
    metrics: dict[str, Any],
) -> None:
    trunk_layers: list[dict[str, Any]] = []
    for module in model.trunk:
        if isinstance(module, nn.Linear):
            trunk_layers.append(linear_spec(module))

    policy_spec = {
        'format': 'bc-mlp-v1',
        'featureNames': metadata['feature_names'],
        'hiddenSizes': hidden_sizes,
        'activation': 'relu',
        'outputLabels': metadata['labels'],
        'normalization': metadata['normalization'],
        'trunk': trunk_layers,
        'heads': {
            'move': linear_spec(model.move_head),
            'fire': linear_spec(model.fire_head),
            'skill': linear_spec(model.skill_head),
        },
        'training': {
            'epochs': args.epochs,
            'batchSize': args.batch_size,
            'learningRate': args.lr,
            'datasetSize': metadata['counts']['train'],
            'validationSize': metadata['counts']['val'],
        },
        'metrics': metrics,
    }

    with output_path.open('w', encoding='utf-8') as handle:
        json.dump(policy_spec, handle, ensure_ascii=False, indent=2)


def export_native_manifest(output_path: Path, metadata: dict[str, Any]) -> None:
    native_manifest = {
        'format': 'bc-native-v1',
        'featureNames': metadata['feature_names'],
        'outputLabels': metadata['labels'],
        'normalization': metadata['normalization'],
        'model': {
            'inputName': 'input',
            'outputNames': {
                'move': 'move_logits',
                'fire': 'fire_logits',
                'skill': 'skill_logits',
            },
        },
    }

    with output_path.open('w', encoding='utf-8') as handle:
        json.dump(native_manifest, handle, ensure_ascii=False, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser(description='Train a behavioral cloning policy from processed BC dataset files.')
    parser.add_argument('--dataset-dir', required=True, help='Directory that contains train.jsonl, val.jsonl and metadata.json.')
    parser.add_argument('--output-dir', required=True, help='Directory to write the trained policy and checkpoint.')
    parser.add_argument('--epochs', type=int, default=12)
    parser.add_argument('--batch-size', type=int, default=64)
    parser.add_argument('--lr', type=float, default=3e-4)
    parser.add_argument('--hidden-sizes', default='256,256', help='Comma-separated hidden layer sizes.')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--device', default='auto', choices=['auto', 'cpu', 'cuda'])
    args = parser.parse_args()

    dataset_dir = Path(args.dataset_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    torch.manual_seed(args.seed)
    if torch.cuda.is_available() and args.device in ('auto', 'cuda'):
        device = torch.device('cuda')
    else:
        device = torch.device('cpu')

    train_dataset, val_dataset, metadata = load_dataset(dataset_dir)
    hidden_sizes = parse_int_list(args.hidden_sizes)
    model = build_model(len(metadata['feature_names']), hidden_sizes).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    criterion = nn.CrossEntropyLoss()

    train_loader = DataLoader(train_dataset, batch_size=args.batch_size, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=args.batch_size, shuffle=False)

    history: list[dict[str, Any]] = []
    best_val_loss = math.inf
    best_state: dict[str, Any] | None = None

    for epoch in range(1, args.epochs + 1):
        train_metrics = run_epoch(model, train_loader, optimizer, criterion, device)
        with torch.no_grad():
            val_metrics = run_epoch(model, val_loader, None, criterion, device)

        epoch_metrics = {
            'epoch': epoch,
            'train': train_metrics,
            'val': val_metrics,
        }
        history.append(epoch_metrics)
        print(
            f"epoch {epoch}/{args.epochs} | "
            f"train_loss={train_metrics['loss']:.4f} val_loss={val_metrics['loss']:.4f} | "
            f"move_acc={val_metrics['move_acc']:.3f} fire_acc={val_metrics['fire_acc']:.3f} skill_acc={val_metrics['skill_acc']:.3f}"
        )

        if val_metrics['loss'] <= best_val_loss:
            best_val_loss = val_metrics['loss']
            best_state = {
                'state_dict': model.state_dict(),
                'epoch': epoch,
                'val_loss': val_metrics['loss'],
            }

    checkpoint_path = output_dir / 'policy.pt'
    torch.save(
        {
            'state_dict': model.state_dict(),
            'metadata': metadata,
            'history': history,
            'args': vars(args),
        },
        checkpoint_path,
    )

    if best_state is not None:
        model.load_state_dict(best_state['state_dict'])

    policy_path = output_dir / 'policy.json'
    export_policy(
        policy_path,
        model,
        metadata,
        hidden_sizes,
        args,
        {
            'bestValLoss': best_val_loss,
            'history': history,
        },
    )

    native_manifest_path = output_dir / 'policy.meta.json'
    export_native_manifest(native_manifest_path, metadata)

    metrics_path = output_dir / 'training-metrics.json'
    with metrics_path.open('w', encoding='utf-8') as handle:
        json.dump(
            {
                'bestValLoss': best_val_loss,
                'history': history,
                'checkpoint': str(checkpoint_path),
                'policy': str(policy_path),
                'nativeManifest': str(native_manifest_path),
            },
            handle,
            ensure_ascii=False,
            indent=2,
        )

    print(json.dumps({
        'checkpoint': str(checkpoint_path),
        'policy': str(policy_path),
        'nativeManifest': str(native_manifest_path),
        'metrics': str(metrics_path),
        'best_val_loss': best_val_loss,
        'device': str(device),
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()