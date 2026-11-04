# Record a clean voice reference for Rita's voice cloning (Sesame CSM speaker context).
# Saves a 24 kHz mono WAV you can hand to csm-voicegen.py --voice.
#
# Usage:
#   python record-reference.py                # ~20 s recording, auto-out
#   python record-reference.py --seconds 25 --out "C:\path\my-voice.wav"
#
# Tips for the best clone: quiet room, mic close, only YOUR voice, natural talk
# for the whole recording (read anything aloud; avoid long pauses). The model
# learns tone, style and accent from this clip. Only record voices you have
# the right / consent to use (the model card forbids nonconsensual cloning).
import argparse
import math
import os
import queue
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=20, help="max recording length")
    ap.add_argument("--out", default="", help="output wav path (default under APPDATA)")
    args = ap.parse_args()

    if os.name != "nt":
        local_app = os.environ.get("LOCALAPPDATA", "")
        base = os.path.join(local_app, "Rita") if local_app else "."
    else:
        base = os.path.join(os.environ.get("APPDATA", "."), "rita-assistant")
    out = args.out or os.path.join(base, "reference", "my-voice-24k.wav")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    import numpy as np
    import sounddevice as sd
    import soundfile as sf

    sr = 48000
    frames = int(sr * 0.1)
    q: "queue.Queue[np.ndarray]" = queue.Queue()
    heard = []

    def cb(indata, _frames, _t, status):
        if status:
            print(f"[rec] {status}", file=sys.stderr)
        mono = indata[:, 0].copy()
        q.put(mono)
        heard.append(mono)

    print(f"[rec] recording up to {args.seconds}s from default mic — talk naturally now!", flush=True)
    with sd.InputStream(samplerate=sr, channels=1, dtype="float32", blocksize=frames, callback=cb):
        blocks: list[np.ndarray] = []
        t0 = time.time()
        quiet_run = 0
        while time.time() - t0 < args.seconds:
            try:
                m = q.get(timeout=1.0)
            except queue.Empty:
                continue
            blocks.append(m)
            r = float(np.sqrt(np.mean(np.square(m))))
            quiet_run = quiet_run + 1 if r < 0.008 else 0
            # heartbeat: after the first ~2 s, print a progress pulse every second so the
            # user can tell it is actually recording (silent failure was a real trap)
            if len(blocks) and len(blocks) % 10 == 0 and len(blocks) > 20:
                print(f"[rec] {len(blocks) * 0.1:.0f}s captured — keep talking for the whole {args.seconds}s", flush=True)
            if quiet_run >= 20:      # ~2 s of dead silence -> stop early
                captured_s = len(blocks) * 0.1
                if captured_s >= min(10, args.seconds * 0.5):
                    print("[rec] 2 s of silence — stopping", flush=True)
                    break
                quiet_run = 0        # too little captured yet: keep waiting for speech
        audio = np.concatenate(blocks).astype("float32") if blocks else np.empty(0, np.float32)

    peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
    if len(audio) < sr * 8:      # under 8 s: not a usable reference clip
        print(f"REC-FAIL only {len(audio) / sr:.1f}s captured (peak={peak:.4f}) — talk continuously, "
              "close to the mic, for the whole recording (the early silence-stop hit you)",
              flush=True)
        return

    # trim leading/trailing low-level noise margins so the clip starts clean
    win = int(sr * 0.05)
    amps = np.sqrt(np.sum(np.square(audio[: (len(audio) // win) * win]).reshape(-1, win), axis=1)) / win
    spoken = np.where(amps > max(0.02, peak * 0.08))[0]
    if len(spoken):
        start = max(0, int(spoken[0]) * win - win)
        end = min(len(audio), int(spoken[-1] + 2) * win)
        audio = audio[start:end]

    from scipy.signal import resample_poly
    g = math.gcd(24000, int(sr))
    audio24 = resample_poly(audio, 24000 // g, sr // g).astype("float32")
    if audio24.ndim == 1:
        audio24 = audio24[:, None]
    sf.write(out, audio24, 24000, subtype="FLOAT")
    peak24 = float(np.max(np.abs(audio24)))
    if peak24 < 0.05:
        print("REC-WEAK peak={:.3f} — mic input level is very low; raise 'Microphone' in Windows Settings > Sound".format(peak24), flush=True)
    print(f"REC-OK {len(audio24) / 24000:.1f}s peak={peak24:.2f} -> {out}", flush=True)


if __name__ == "__main__":
    main()
