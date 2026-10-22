# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = [
#     "torch==2.9.1",
#     "kokoro==0.9.4",
#     "onnx",
#     "onnxruntime",
#     "numpy",
#     "huggingface-hub",
# ]
# ///
"""Exports Kokoro-82M v1.0 to ONNX with its predicted durations as an output.

    uv run packaging/kokoro-onnx/export.py [--out-dir DIR] [--verify-only]

The worker used to load onnx-community's export, whose only output is the
waveform, so word timings came from a Whisper pass over the finished audio.
Kokoro's duration predictor already says how many frames each phoneme token
gets, and the vocoder renders exactly those frames, so the durations *are*
the alignment. This exports `kokoro.model.KModelForONNX` — Kokoro's own
wrapper, which returns `(waveform, duration)` — from the same checkpoint the
iOS Core AI export uses, keeping onnx-community's input names (`input_ids`,
`style`, `speed`) so the worker's call is unchanged apart from the new output.

`duration` is int64 frames per token, the leading and trailing sentinel
included, after speed is applied (`round(d / speed)`, at least 1). At 24 kHz
one frame is 600 samples, and the waveform is exactly `sum(duration) * 600`
samples long.

After exporting, the script checks the ONNX graph against PyTorch on a few
token sequences: durations must match exactly and the spectrogram closely
(the vocoder's noise makes the waveform itself differ run to run). `--verify-only` re-runs that check on an existing export.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import torch
from huggingface_hub import hf_hub_download

REPO = "hexgrad/Kokoro-82M"
# The revision the iOS Core AI export pins (openreader-ios tools/kokoro).
REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
OPSET = 20
SAMPLES_PER_FRAME = 600
HERE = Path(__file__).resolve().parent


def load_model():
    from kokoro.model import KModel, KModelForONNX

    config = hf_hub_download(REPO, "config.json", revision=REVISION)
    weights = hf_hub_download(REPO, "kokoro-v1_0.pth", revision=REVISION)
    # disable_complex swaps the complex STFT for Kokoro's real-valued one,
    # which ONNX can express.
    model = KModel(repo_id=REPO, config=config, model=weights, disable_complex=True).eval()
    with open(config, encoding="utf-8") as f:
        vocab = json.load(f)["vocab"]
    return KModelForONNX(model).eval(), vocab


def voice_style(name: str, token_count: int) -> torch.Tensor:
    pack = torch.load(hf_hub_download(REPO, f"voices/{name}.pt", revision=REVISION), weights_only=True)
    # One style row per phoneme count, as KPipeline indexes it.
    return pack[token_count - 3].reshape(1, 256).float()


def encode(vocab: dict[str, int], phonemes: str) -> torch.Tensor:
    ids = [vocab[p] for p in phonemes if p in vocab]
    return torch.tensor([[0, *ids, 0]], dtype=torch.long)


CASES = [
    ("af_heart", "həlˈO wˈɜɹld."),
    ("am_michael", "ðə kwˈɪk bɹˈWn fˈɑks ʤˈʌmps ˌOvəɹ ðə lˈAzi dˈɔɡ."),
    ("bf_emma", "ɪt wˈɒz ðə bˈɛst ɒv tˈImz, ɪt wˈɒz ðə wˈɜːst ɒv tˈImz."),
]


def export(wrapper, vocab, path: Path) -> None:
    ids = encode(vocab, CASES[1][1])
    style = voice_style(CASES[1][0], ids.shape[1])
    speed = torch.tensor([1.0], dtype=torch.float32)
    torch.onnx.export(
        wrapper,
        (ids, style, speed),
        str(path),
        input_names=["input_ids", "style", "speed"],
        output_names=["waveform", "duration"],
        dynamic_axes={
            "input_ids": {1: "tokens"},
            "waveform": {0: "samples"},
            "duration": {0: "tokens"},
        },
        opset_version=OPSET,
        dynamo=False,
    )


def verify(wrapper, vocab, path: Path) -> None:
    import onnxruntime as ort

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    print("inputs", [i.name for i in session.get_inputs()], "outputs", [o.name for o in session.get_outputs()])
    for voice, phonemes in CASES:
        for speed in (1.0, 1.3):
            ids = encode(vocab, phonemes)
            style = voice_style(voice, ids.shape[1])
            with torch.no_grad():
                ref_audio, ref_dur = wrapper(ids, style, torch.tensor([speed]))
            audio, dur = session.run(None, {
                "input_ids": ids.numpy(),
                "style": style.numpy(),
                "speed": np.array([speed], dtype=np.float32),
            })
            ref_audio, ref_dur = ref_audio.numpy(), ref_dur.numpy()
            assert np.array_equal(dur, ref_dur), (voice, speed, dur, ref_dur)
            assert dur.shape[0] == ids.shape[1], (dur.shape, ids.shape)
            assert audio.shape[0] == int(dur.sum()) * SAMPLES_PER_FRAME, (audio.shape, dur.sum())
            # The vocoder's source adds random phase and noise, so two runs never
            # agree sample for sample (not even PyTorch with itself); compare
            # the log-magnitude spectrograms instead.
            corr = float(np.corrcoef(log_spectrogram(audio).ravel(), log_spectrogram(ref_audio).ravel())[0, 1])
            print(f"{voice} speed {speed}: tokens {ids.shape[1]}, frames {int(dur.sum())}, "
                  f"spectrogram corr {corr:.4f}")
            assert corr > 0.98, corr


def log_spectrogram(audio: np.ndarray) -> np.ndarray:
    frames = np.lib.stride_tricks.sliding_window_view(audio, 1024)[::SAMPLES_PER_FRAME // 2]
    return np.log1p(np.abs(np.fft.rfft(frames * np.hanning(1024), axis=-1)))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", type=Path, default=HERE / "build")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    path = args.out_dir / "model.onnx"

    torch.manual_seed(0)
    wrapper, vocab = load_model()
    if not args.verify_only:
        export(wrapper, vocab, path)
    verify(wrapper, vocab, path)
    print(f"{path}: {os.path.getsize(path)} bytes, sha256 {sha256(path)}")


if __name__ == "__main__":
    main()
