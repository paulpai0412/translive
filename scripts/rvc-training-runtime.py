#!/usr/bin/env python3
# pyright: reportMissingImports=false
"""Pinned local-only RVC trainer and weights-only verifier for TransLive.

This program is copied into the fixed %LOCALAPPDATA%/TransLive/rvc-runtime
layout and hash-pinned by runtime-manifest.json. It deliberately accepts no
network URL, no arbitrary executable, no provider other than CPU training, and
writes only JSON progress records to stdout.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
from typing import Any, cast

RVC_COMMIT = "81eed5e8f68b6bed1789f682fe78cdd324495afc"
HF_REVISION = "e6d0c1a17da07c33557852f9dfa2bd44cc75737d"
SAMPLE_RATE = "40k"
VERSION = "v2"
BATCH_SIZE = "1"
TOTAL_EPOCHS = "20"
SAVE_EVERY_EPOCHS = "5"
ISOLATED_BOOTSTRAP = (
    "import runpy,sys; root=sys.argv[1]; script=sys.argv[2]; "
    "sys.path[:0]=[root]; sys.argv=[script,*sys.argv[3:]]; "
    "runpy.run_path(script,run_name='__main__')"
)


def fail(code: str) -> None:
    raise RuntimeError(f"VOICE_TRAINING_RUNNER_{code}")


def emit(progress: int, stage: str) -> None:
    print(json.dumps({"progress": progress, "stage": stage}), flush=True)


def inside(root: Path, value: str | Path, suffix: str | None = None) -> Path:
    candidate = Path(value).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        fail("PATH")
    if suffix and candidate.suffix.lower() != suffix:
        fail("PATH")
    return candidate


def session_id(value: str) -> str:
    if not value.startswith("vt_") or len(value) > 100:
        fail("SESSION")
    if not all(char.isalnum() or char in "_-" for char in value):
        fail("SESSION")
    return value


def runner_paths(runtime_root: Path) -> tuple[Path, Path]:
    source = runtime_root / "source"
    if not source.is_dir() or not (source / "train" / "train.py").is_file():
        fail("SOURCE")
    return source, runtime_root / ".venv" / "Scripts" / "python.exe"


def isolated_env(python: Path) -> dict[str, str]:
    system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR") or ""
    path_items = [str(python.parent)]
    if system_root:
        path_items.append(str(Path(system_root) / "System32"))
    return {
        "ComSpec": str(Path(system_root) / "System32" / "cmd.exe") if system_root else "",
        "PATH": os.pathsep.join(path_items),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONHOME": "",
        "PYTHONNOUSERSITE": "1",
        "PYTHONPATH": "",
        "PYTHONSAFEPATH": "1",
        "PYTHONUSERBASE": "",
        "SystemRoot": system_root,
        "WINDIR": system_root,
    }


def run_fixed(args: list[str], *, cwd: Path) -> None:
    python = Path(args[0]).resolve()
    script = (cwd / args[1]).resolve()
    if not script.is_file() or cwd not in script.parents:
        fail("SOURCE")
    completed = subprocess.run(
        [
            str(python),
            "-I",
            "-c",
            ISOLATED_BOOTSTRAP,
            str(cwd),
            str(script),
            *args[2:],
        ],
        cwd=str(cwd),
        check=False,
        env=isolated_env(python),
        shell=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if completed.returncode != 0:
        fail("TRAINING_STEP")


def build_filelist(source: Path, log_dir: Path) -> None:
    wav_dir = log_dir / "0_gt_wavs"
    feature_dir = log_dir / "3_feature768"
    f0_dir = log_dir / "2a_f0"
    f0nsf_dir = log_dir / "2b-f0nsf"
    names = sorted(
        path.stem
        for path in wav_dir.glob("*.wav")
        if (feature_dir / f"{path.stem}.npy").is_file()
        and (f0_dir / f"{path.stem}.wav.npy").is_file()
        and (f0nsf_dir / f"{path.stem}.wav.npy").is_file()
    )
    if not names:
        fail("FEATURES")
    lines = [
        "|".join(
            [
                str(wav_dir / f"{name}.wav").replace("\\", "\\\\"),
                str(feature_dir / f"{name}.npy").replace("\\", "\\\\"),
                str(f0_dir / f"{name}.wav.npy").replace("\\", "\\\\"),
                str(f0nsf_dir / f"{name}.wav.npy").replace("\\", "\\\\"),
                "0",
            ]
        )
        for name in names
    ]
    mute_root = source / "logs" / "mute"
    for _ in range(2):
        lines.append(
            "|".join(
                [
                    str(mute_root / "0_gt_wavs" / "mute40k.wav").replace("\\", "\\\\"),
                    str(mute_root / "3_feature768" / "mute.npy").replace("\\", "\\\\"),
                    str(mute_root / "2a_f0" / "mute.wav.npy").replace("\\", "\\\\"),
                    str(mute_root / "2b-f0nsf" / "mute.wav.npy").replace("\\", "\\\\"),
                    "0",
                ]
            )
        )
    (log_dir / "filelist.txt").write_text("\n".join(lines), encoding="utf-8")
    shutil.copyfile(source / "configs" / "v2" / "40k.json", log_dir / "config.json")


def train(args: argparse.Namespace) -> None:
    runtime_root = Path(args.runtime_root).resolve()
    work_root = Path(args.work_root).resolve()
    source, python = runner_paths(runtime_root)
    if args.provider != "cpu-baseline":
        fail("PROVIDER")
    session = session_id(args.session_id)
    input_path = inside(work_root, args.input, ".wav")
    output_path = inside(work_root, args.output, ".pth")
    if not input_path.is_file():
        fail("INPUT")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    log_dir = source / "logs" / session
    if log_dir.exists():
        try:
            shutil.rmtree(log_dir)
        except OSError:
            fail("WORKSPACE_CLEANUP")
    log_dir.mkdir(parents=True)
    try:
        emit(5, "preprocess")
        run_fixed(
            [
                str(python),
                "train/preprocess.py",
                str(input_path.parent),
                "40000",
                "1",
                str(log_dir),
                "0",
                "3.7",
            ],
            cwd=source,
        )
        emit(25, "pitch")
        run_fixed(
            [str(python), "train/dataset/extract_f0.py", "cpu", str(log_dir), "1", "rmvpe"],
            cwd=source,
        )
        emit(45, "features")
        run_fixed(
            [
                str(python),
                "train/dataset/extract_hubert_feature.py",
                "cpu",
                "1",
                "0",
                str(log_dir),
                VERSION,
                "False",
            ],
            cwd=source,
        )
        build_filelist(source, log_dir)
        emit(60, "training")
        run_fixed(
            [
                str(python),
                "train/train.py",
                "-e",
                session,
                "-sr",
                SAMPLE_RATE,
                "-f0",
                "1",
                "-bs",
                BATCH_SIZE,
                "-te",
                TOTAL_EPOCHS,
                "-se",
                SAVE_EVERY_EPOCHS,
                "-pg",
                "assets/pretrained_v2/f0G40k.pth",
                "-pd",
                "assets/pretrained_v2/f0D40k.pth",
                "-l",
                "1",
                "-c",
                "0",
                "-sw",
                "0",
                "-v",
                VERSION,
            ],
            cwd=source,
        )
        generated = source / "assets" / "weights" / f"{session}.pth"
        if not generated.is_file() or generated.stat().st_size <= 0:
            fail("OUTPUT")
        shutil.copyfile(generated, output_path)
        emit(95, "verifying")
        verify_model(output_path)
        emit(100, "completed")
    finally:
        shutil.rmtree(log_dir, ignore_errors=True)
        generated = source / "assets" / "weights" / f"{session}.pth"
        generated.unlink(missing_ok=True)


def verify_model(model_path: Path) -> dict[str, int | str | bool]:
    import torch

    # This independent verifier intentionally uses PyTorch's restricted loader.
    checkpoint: Any = torch.load(  # nosemgrep: trailofbits.python.pickles-in-pytorch.pickles-in-pytorch
        model_path,
        map_location="cpu",
        weights_only=True,
    )
    if not isinstance(checkpoint, dict):
        fail("VERIFY_SCHEMA")
    raw_config = checkpoint.get("config")
    raw_model = checkpoint.get("model")
    if not isinstance(raw_config, (list, tuple)) or len(raw_config) < 8:
        fail("VERIFY_SCHEMA")
    if not isinstance(raw_model, dict) or not raw_model:
        fail("VERIFY_SCHEMA")
    config = cast(list[Any] | tuple[Any, ...], raw_config)
    model = cast(dict[str, Any], raw_model)
    tensor_count = sum(1 for value in model.values() if isinstance(value, torch.Tensor))
    if tensor_count < 1:
        fail("VERIFY_SCHEMA")
    if checkpoint.get("version") not in {"v1", "v2"}:
        fail("VERIFY_SCHEMA")
    if checkpoint.get("sr") not in {"32k", "40k", "48k"}:
        fail("VERIFY_SCHEMA")
    with model_path.open("rb") as handle:
        digest = hashlib.file_digest(handle, "sha256").hexdigest()
    return {
        "configLength": len(config),
        "schema": "rvc-checkpoint-v2",
        "sha256": digest,
        "tensorCount": tensor_count,
        "verified": True,
    }


def verify(args: argparse.Namespace) -> None:
    work_root = Path(args.work_root).resolve()
    model_path = inside(work_root, args.model, ".pth")
    print(json.dumps(verify_model(model_path)), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("train", "verify"), required=True)
    parser.add_argument("--runtime-root", required=False)
    parser.add_argument("--work-root", required=True)
    parser.add_argument("--session-id")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--provider")
    parser.add_argument("--model")
    args = parser.parse_args()
    if args.mode == "train":
        required = (args.runtime_root, args.session_id, args.input, args.output, args.provider)
        if any(value is None for value in required):
            fail("ARGS")
        train(args)
    else:
        if args.model is None:
            fail("ARGS")
        verify(args)


if __name__ == "__main__":
    signal.signal(
        signal.SIGTERM,
        lambda _signum, _frame: (_ for _ in ()).throw(KeyboardInterrupt()),
    )
    try:
        main()
    except Exception:
        # No path or upstream stderr reaches Electron/UI. Main only receives a
        # nonzero exit and retains raw GPT audio / failed local training state.
        raise SystemExit(1)
