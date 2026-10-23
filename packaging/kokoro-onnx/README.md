# Kokoro ONNX

Local Kokoro (`kokoro-local`) runs Kokoro-82M on onnxruntime in the compute
worker. OpenReader exports the ONNX model itself, so that the model also
returns its predicted duration for each phoneme token. Those durations are the
word timings: the vocoder renders exactly those frames. Local Kokoro segments
therefore arrive aligned, with no Whisper pass.

The export is published under `onnx/` in
[richardr1126/Kokoro-82M-OpenReader](https://huggingface.co/richardr1126/Kokoro-82M-OpenReader).
The same repository holds the iOS app's Core AI bundles, made from the same
checkpoint. The worker pins a revision of it, with each file's size and SHA-256
(`packages/compute-worker/src/inference/kokoro/model-files.ts`), and downloads
the files on first use.

## Files

- `export.py`: a self-contained `uv` script. It loads
  `hexgrad/Kokoro-82M` at the revision the iOS export pins, exports
  `kokoro.model.KModelForONNX` (inputs `input_ids`, `style`, `speed`; outputs
  `waveform`, `duration`), then checks the result against PyTorch. Durations
  must match exactly, the audio length must equal the frame total, and the
  log-spectrogram must correlate closely. Output goes to `build/`, which git
  ignores.

```sh
uv run packaging/kokoro-onnx/export.py
uv run packaging/kokoro-onnx/export.py --verify-only
```

## Publishing a new export

1. Run the script and note the printed size and SHA-256.
2. Upload `model.onnx` to `onnx/` in the Hugging Face repository, and update
   `onnx/SHA256SUMS` there.
3. Pin the new commit, size and SHA-256 in `model-files.ts`. Existing installs
   download the replacement on their next start, because the checksum no
   longer matches.

The voice packs in `onnx/voices/` are onnx-community's, byte for byte, so their
pinned checksums do not change.

## Timing contract

`duration[i]` is the frame count of input token `i`, the two pad tokens
included, after `speed`. One frame is 600 samples at 24 kHz. The worker
assigns each Misaki token the frames of its own phonemes, joins tokens into
the text's words, and shifts the result by `MP3_ENCODER_DELAY_SEC`, the delay
that MP3 normalization adds to the stored audio
(`packages/tts/src/audio-format.ts`).
