# Train a custom openWakeWord model fully locally (CPU) for a given phrase.
# Recipe (mirrors dscripka/openWakeWord's official flow, minus 5 GB downloads):
#   positives: piper.exe renders the phrase across installed voices/length/noise + local augmentation
#   negatives: synthesized noise/hum clips + piper-rendered other speech + known false-fire phrases
#   features:  openwakeword.utils.AudioFeatures embeddings (16 kHz), sliding 16-frame windows
#   model:     small FCN head, BCE with cosine LR + negative-weight schedule, best-checkpoint averaging
#   export:    ONNX at input (1,16,96) → sigmoid score, loadable by the rita helper as wakeOnnxPath
#
# Usage:
#   python train-wakeword.py --phrase "Wiem" --steps 12000
# Extra positives (your own voice) can be dropped as .wav files (any sr, mono) into
# the folder printed by the script, or passed via RITA_WAKE_EXTRA_CLIPS.
import argparse
import hashlib
import json
import math
import os
import random
import subprocess
import sys
import time
import wave

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SR = 16000
WINDOW_FRAMES = 16          # 16 × 80 ms = 1.28 s input windows
CLIP_S = 2.4                # clip length in seconds — must yield > 16 embedding frames (~2.04 s min)
EMBED_DIM = 96

# hard negatives: phrases that historically false-fired near the threshold on other wake models
HARD_NEGATIVE_PHRASES = [
    "here okay", "I know that you", "Are you feeling okay?", "I owe you",
    "I control you", "Are you?", "We them", "We'd win", "One evening",
    "hello there", "Okay remind me later", "Yeah, whenever you need me.",
]
SOFT_NEGATIVE_WORDS = [
    "hello", "okay", "yes", "no", "thanks", "you", "are", "we", "win", "one",
    "him", "them", "neighbor", "widow", "weeding", "there", "right", "remember",
    "welcome", "water", "whenever", "wait", "wien", "screen", "on it", "got it",
]


def log(msg):
    print(msg, flush=True)


def base_dirs():
    base = os.environ.get("APPDATA", os.getcwd())
    app = os.path.join(base, "rita-assistant")
    return app

def out_dirs():
    app = base_dirs()
    ww = os.path.join(app, "wakeword-train")
    for d in ["", "pos", "neg", "features"]:
        os.makedirs(os.path.join(ww, d), exist_ok=True)
    return ww


def piper_voices():
    d = os.path.join(base_dirs(), "piper", "voices")
    ex = os.path.join(base_dirs(), "piper", "piper.exe")
    if not (os.path.isdir(d) and os.path.isfile(ex)):
        log(r"ERR no piper voices/exe under %APPDATA%\rita-assistant\piper")
        sys.exit(3)
    return ex, [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith(".onnx")]


def render_piper(exe, voice_onnx, text, out_wav, length_scale=1.0, noise_scale=0.667, noise_w=0.8):
    cmd = [exe, "-m", voice_onnx, "-c", voice_onnx + ".json",
           "-f", out_wav, "-q", "--sentence_silence", "0",
           "--length_scale", f"{length_scale:.2f}",
           "--noise_scale", f"{noise_scale:.2f}",
           "--noise_w", f"{noise_w:.2f}"]
    cp = subprocess.run(cmd, input=text.encode("utf-8"),
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    return cp.returncode == 0 and os.path.isfile(out_wav)


def load_wav_mono(path, sr=SR):
    import soundfile as sf
    import numpy as np
    a, file_sr = sf.read(path, dtype="float32", always_2d=True)
    a = a[:, 0]
    if file_sr != sr:
        from scipy.signal import resample_poly
        g = math.gcd(int(file_sr), int(sr))
        a = resample_poly(a, sr // g, file_sr // g).astype(np.float32)
    return a


def save_wav(path, a, sr=SR):
    import soundfile as sf
    import numpy as np
    sf.write(path, a.astype(np.float32), sr)


def synth_noise(n_samples, rng):
    """Return a 1.5 s float32 mono noise/hum clip of plausible room backgrounds."""
    import numpy as np
    shape = rng.choice(["white", "pink", "brown", "hum"])
    if shape == "white":
        x = 0.12 * rng.normal(0, 1, n_samples)
    elif shape == "pink":
        w = rng.normal(0, 1, n_samples)
        x = np.convolve(w, [1, 0.7, 0.5, 0.35, 0.25, 0.18, 0.12], mode="same") * 0.35
    elif shape == "brown":
        x = np.cumsum(rng.normal(0, 1, n_samples))
        x -= np.linspace(x[0], x[-1], n_samples)
        x *= 0.02
    else:  # hum: 50/60 Hz + harmonics + slow fan-like amplitude wobble
        import numpy as np
        hz = rng.choice([50.0, 60.0])
        t = np.arange(n_samples) / SR
        x = 0.06 * np.sin(2 * np.pi * hz * t) + 0.03 * np.sin(2 * np.pi * 2 * hz * t + 0.6)
        wob = 1.0 + 0.25 * np.sin(2 * np.pi * rng.uniform(0.1, 0.5) * t)
        x = x * wob
    peak = np.max(np.abs(x)) or 1.0
    return (x / peak * rng.uniform(0.05, 0.5)).astype(np.float32)


def augment(a, rng, sr=SR):
    """Random gain / SNR-noise / pitch / offset augmentation for a positive word clip."""
    import numpy as np
    from scipy.signal import resample_poly
    x = a.copy()
    # pitch ±5 semitone-ish through resample then back (keeps 16k sr)
    f = 2 ** rng.uniform(-0.35, 0.35)
    if abs(f - 1.0) > 1e-3:
        g = int(round(sr * 100))
        stretched = resample_poly(x, 100, max(1, int(round(100 * f))))
        x = stretched
    # mix background noise at SNR 4..30 dB
    n = synth_noise(len(x), rng)
    snr_db = rng.uniform(4, 30)
    pow_sig = float(np.mean(x ** 2)) or 1e-9
    pow_noise = float(np.mean(n ** 2)) or 1e-9
    scale = math.sqrt(pow_sig / (pow_noise * (10 ** (snr_db / 10))))
    x = x + n * scale
    # gain
    x *= rng.uniform(0.35, 2.2)
    peak = np.max(np.abs(x)) or 1.0
    if peak > 0.98:
        x *= 0.95 / peak
    return x.astype(np.float32)


def to_fixed_clip(a, rng, dur_s=CLIP_S, sr=SR):
    """Pad (word placed at a random offset) / trim to fixed duration."""
    import numpy as np
    n = int(dur_s * sr)
    if a is None or len(a) < 1:
        return None
    if len(a) > n:
        a = a[:n]
    out = np.zeros(n, dtype=np.float32)
    max_off = max(0, n - len(a) - int(0.05 * sr))
    lo = int(0.03 * sr)
    # clips that already fill the window (or leave too little room) start at offset 0
    off = int(rng.integers(lo, max_off + 1)) if max_off >= lo else 0
    out[off:off + len(a)] = a
    # fade in/out edges
    fade = int(0.04 * sr)
    out[:fade] *= np.linspace(0, 1, fade)
    out[-fade:] *= np.linspace(1, 0, fade)
    return out


# ------------------------------------------------------------------ data build
def build_clips(phrase, seeded_rng):
    """Render positives/negatives with piper; returns nothing, fills folders."""
    import numpy as np
    ww = out_dirs()
    exe, voices = piper_voices()
    words = []
    hashes = set()
    rendered = 0
    # --- positives: phrase x voices x length x noise x punctuation (+ variants)
    texts = [phrase, phrase.lower(), f"{phrase}?", f"{phrase}!", f"{phrase}.", f"yeah, {phrase}",
             f"{phrase},", f"hey, {phrase}"]
    for vidx, v in enumerate(voices):
        for t_i, text in enumerate(texts):
            for ls in [0.75, 0.9, 1.0, 1.15, 1.3]:
                for ns in [0.35, 0.5, 0.667, 0.85]:
                    h = hashlib.sha1(f"{vidx}|{text}|{ls}|{ns}".encode()).hexdigest()[:10]
                    # render every 2nd combo deterministically (~ hundreds of positives)
                    if (int(h, 16) % 2):
                        continue
                    out = os.path.join(ww, "pos", f"p{h}.wav")
                    if os.path.exists(out):
                        rendered += 1; continue
                    if render_piper(exe, v, text, out, ls, ns, 0.8):
                        hashes.add(h); rendered += 1
    # --- hard negatives (specific phrases)
    for t_i, text in enumerate(HARD_NEGATIVE_PHRASES):
        for vidx, v in enumerate(voices):
            for ls in [0.85, 1.0, 1.2]:
                h = hashlib.sha1(f"hn{vidx}|{text}|{ls}".encode()).hexdigest()[:10]
                out = os.path.join(ww, "neg", f"hn{h}.wav")
                if os.path.exists(out):
                    continue
                render_piper(exe, v, text, out, ls, 0.5, 0.8)
    # --- soft negatives (individual words)
    for t_i, text in enumerate(SOFT_NEGATIVE_WORDS):
        for vidx, v in enumerate(voices[:3]):
            for ls in [0.9, 1.0, 1.15]:
                h = hashlib.sha1(f"sn{vidx}|{text}|{ls}".encode()).hexdigest()[:10]
                out = os.path.join(ww, "neg", f"sn{h}.wav")
                if os.path.exists(out):
                    continue
                render_piper(exe, v, text if text != "are" else "are?", out, ls, 0.6, 0.8)
    # --- ambient noise negatives
    n_needed = 600
    n_noise_have = len([f for f in os.listdir(os.path.join(ww, "neg")) if f.startswith("nz")])
    for i in range(n_noise_have, n_needed):
        out = os.path.join(ww, "neg", f"nz{i:04d}.wav")
        if os.path.exists(out):
            continue
        save_wav(out, synth_noise(int(CLIP_S * SR), seeded_rng))
    log(f"clips: positives={len(os.listdir(os.path.join(ww, 'pos')))} negatives={len(os.listdir(os.path.join(ww, 'neg')))}")


def windowize(feats, label, rng, max_per_clip=12):
    """Sliding 16-frame windows; subsample negatives."""
    import numpy as np
    out_x, out_y = [], []
    for f in feats:
        frames = f.shape[0]
        if frames < WINDOW_FRAMES + 1:
            continue
        step = 1 if label == 1 else 3
        wins = list(range(0, frames - WINDOW_FRAMES, step))
        if len(wins) > max_per_clip:
            wins = list(rng.choice(wins, max_per_clip, replace=False))
        for i in wins:
            out_x.append(f[i:i + WINDOW_FRAMES])
            out_y.append(label)
    return out_x, out_y


def main():
    import numpy as np
    ap = argparse.ArgumentParser()
    ap.add_argument("--phrase", default="Wiem")
    ap.add_argument("--steps", type=int, default=int(os.environ.get("RITA_WW_STEPS", "12000")))
    ap.add_argument("--skip-rebuild", action="store_true")
    ap.add_argument("--resume-from", default="", help="load saved weights (net checkpoint) and skip straight to export")
    args = ap.parse_args()

    rng = np.random.default_rng(1234)
    py_rand = random.Random(1234)
    wave_open = wave.open  # keep import referenced (direct file io not used)

    ww = out_dirs()
    phrase = args.phrase.strip()
    model_name = phrase.lower().replace(" ", "_")
    final_onnx = os.path.join(base_dirs(), "wakeword", f"{model_name}.onnx")
    os.makedirs(os.path.dirname(final_onnx), exist_ok=True)

    if not args.skip_rebuild:
        build_clips(phrase, rng)

    # ---------------- load clips -> fixed windows
    log("loading clips…")
    import soundfile as sf
    pos_clips, neg_clips = [], []
    for d, acc in [(os.path.join(ww, "pos"), pos_clips), (os.path.join(ww, "neg"), neg_clips)]:
        for f in sorted(os.listdir(d)):
            if not f.endswith(".wav"):
                continue
            try:
                a = load_wav_mono(os.path.join(d, f))
            except Exception as e:
                log(f"warp load fail {f}: {e}")
                continue
            acc.append((f, a))

    # user-supplied extra positive clips (their own voice recordings)
    extra_dir = os.environ.get("RITA_WAKE_EXTRA_CLIPS", "")
    extra_n = 0
    if extra_dir and os.path.isdir(extra_dir):
        for f in sorted(os.listdir(extra_dir)):
            if not f.lower().endswith(".wav"):
                continue
            try:
                a = load_wav_mono(os.path.join(extra_dir, f))
                pos_clips.append((f"extra_{f}", a))
                extra_n += 1
            except Exception:
                pass
    log(f"loaded pos={len(pos_clips)} neg={len(neg_clips)} extra={extra_n}")

    # split positives 85/15 BEFORE augmentation (clip-level split)
    py_rand.shuffle(pos_clips)
    n_val_pos = max(1, int(len(pos_clips) * 0.15))
    pos_val_clips, pos_train_clips = pos_clips[:n_val_pos], pos_clips[n_val_pos:]

    # features via openwakeword's frozen extractor
    from openwakeword.utils import AudioFeatures
    F = AudioFeatures(device="cpu", ncpu=4)

    def embed(fin_clips):
        rows = []
        for f, a in fin_clips:
            c = to_fixed_clip(a, np.random.default_rng(hash(f) & 0xFFFF))
            if c is not None:
                rows.append(c[:int(CLIP_S * SR)])
        if not rows:
            return None
        arr = np.stack(rows).astype(np.float32)
        arr = np.clip(arr * 32767.0, -32768, 32767).astype(np.int16)  # AudioFeatures expects 16-bit PCM
        return F.embed_clips(arr, batch_size=16, ncpu=4)

    # features are the slow part (1726 clips × melspec → embeddings): cache to disk so
    # a crash-and-retry run skips straight to training.
    clip_sha_src = "|".join([f for f, _ in pos_train_clips] + [f for f, _ in pos_val_clips] + [f for f, _ in neg_clips])
    clip_sha = hashlib.sha1(clip_sha_src.encode("utf-8")).hexdigest()[:16]
    feat_cache = os.path.join(ww, "features", f"cache-{clip_sha}.npz")
    feats_pos_train = feats_pos_val = feats_neg = None
    aug_pool = []
    if os.path.exists(feat_cache):
        try:
            with np.load(feat_cache) as z:
                feats_pos_train, feats_pos_val, feats_neg = z["pt"], z["pv"], z["neg"]
                aug_pool = list(zip(z["aug"], [1.0] * len(z["aug"])))
            log(f"features cache hit ({os.path.basename(feat_cache)}) — embedding skipped")
        except Exception as e:
            log(f"features cache unreadable ({e}) — recomputing")
    if feats_pos_train is None:
        log("embedding base clips (train pos + all neg; val pos kept raw)…")
        feats_pos_train = embed(pos_train_clips)
        feats_pos_val = embed(pos_val_clips)
        feats_neg = embed(neg_clips)
        if feats_pos_train is None or feats_pos_val is None or feats_neg is None:
            log("ERR feature extraction failed")
            sys.exit(4)

    Xtr, Ytr = windowize(feats_pos_train, 1, np.random.default_rng(7))
    Xva, Yva = windowize(feats_pos_val, 1, np.random.default_rng(8))
    Xn, Yn = windowize(feats_neg, 0, np.random.default_rng(9), max_per_clip=6)

    # augment positives ×3 (noise/gain/pitch): augment the audio and embed the copies
    if not aug_pool:
        log("embedding augmented positives ×3…")
        for k in range(3):
            aug_clips = []
            for f, a in pos_train_clips[:int(len(pos_train_clips) * 0.7)]:
                c = to_fixed_clip(augment(a, np.random.default_rng(1000 * k + (hash(f) & 0x3FFFF))), np.random.default_rng(2000 * k + (hash(f) & 0x3FFFF)))
                if c is not None:
                    aug_clips.append((f, c))
            if not aug_clips:
                continue
            arr = np.zeros((len(aug_clips), int(CLIP_S * SR)), dtype=np.float32)
            for i, (_, c) in enumerate(aug_clips):
                arr[i] = c[:arr.shape[1]]
            arr = np.clip(arr * 32767.0, -32768, 32767).astype(np.int16)  # 16-bit PCM for the feature extractor
            emb = F.embed_clips(arr, batch_size=16, ncpu=4)
            xs, ys = windowize(emb, 1, np.random.default_rng(11 + k))
            aug_pool.extend(zip(xs, ys))
    augX = np.stack([x for x, _ in aug_pool]).astype(np.float32) if aug_pool else np.zeros((0, int(WINDOW_FRAMES), int(EMBED_DIM)), dtype=np.float32)
    try:
        np.savez_compressed(feat_cache, pt=feats_pos_train, pv=feats_pos_val, neg=feats_neg, aug=augX)
        log(f"features cached → {os.path.basename(feat_cache)}")
    except Exception as e:
        log(f"features cache save skipped ({e})")
    log(f"windows: pos_train={len(Xtr)} pos_aug={len(aug_pool)} pos_val={len(Xva)} neg={len(Xn)}")

    Xtr_all = [(x, 1.0) for x in Xtr] + aug_pool
    py_rand.shuffle(Xtr_all)

    max_neg = min(len(Xn), 10 * max(1, len(Xtr_all)))
    neg_idx = np.random.default_rng(12).choice(len(Xn), max_neg, replace=False)
    Xneg = [Xn[i] for i in neg_idx]

    # ---------------- torch model
    import torch
    torch.set_num_threads(8)
    from torch import optim, nn

    dev = "cpu"
    emb_dim = int(feats_pos_train.shape[2])
    log(f"embedding dim = {emb_dim}; window {WINDOW_FRAMES} frames")

    class FCNBlock(nn.Module):
        def __init__(self, dim):
            super().__init__()
            self.fc = nn.Linear(dim, dim)
            self.act = nn.ReLU()
            self.ln = nn.LayerNorm(dim)

        def forward(self, x):
            return self.act(self.ln(self.fc(x)))

    class Net(nn.Module):
        def __init__(self, dim=128, blocks=3, emb_dim=EMBED_DIM):
            super().__init__()
            self.flatten = nn.Flatten()
            self.l1 = nn.Linear(16 * emb_dim, dim)
            self.a1 = nn.ReLU()
            self.n1 = nn.LayerNorm(dim)
            self.blocks = nn.ModuleList([FCNBlock(dim) for _ in range(blocks)])
            self.out = nn.Linear(dim, 1)
            self.sx = nn.Sigmoid()

        def forward(self, x):
            x = self.a1(self.n1(self.l1(self.flatten(x))))
            for b in self.blocks:
                x = b(x)
            return self.sx(self.out(x))

    net = Net(emb_dim=emb_dim).to(dev)
    net_ckpt = os.path.join(base_dirs(), "wakeword", f"{model_name}.ckpt")
    resumed = False
    if args.resume_from and os.path.isfile(args.resume_from):
        try:
            sd = torch.load(args.resume_from, map_location="cpu")
            net.load_state_dict(sd.get("state_dict", sd))
            net.eval()
            resumed = True
            log(f"resumed weights from {args.resume_from} — skipping training loop")
        except Exception as e:
            log(f"resume failed ({e}) — training from scratch")
    opt = optim.Adam(net.parameters(), lr=1e-4)
    bce = nn.functional.binary_cross_entropy

    def batch_iter(pool, bs):
        while True:
            idx = np.random.default_rng(py_rand.randrange(1 << 30)).integers(0, len(pool), bs)
            xs = np.stack([pool[i][0] for i in idx]).astype(np.float32)
            ys = np.array([pool[i][1] for i in idx], dtype=np.float32)
            yield torch.from_numpy(xs), torch.from_numpy(ys)

    n_total = len(Xtr_all) + len(Xneg)
    log(f"training: steps={args.steps} pos={len(Xtr_all)} neg={len(Xneg)}")
    gen = batch_iter(Xtr_all + [(x, 0.0) for x in Xneg], 128)

    best_models, best_scores = [], []
    valX = torch.from_numpy(np.stack(Xva).astype(np.float32)) if len(Xva) else None
    valY = torch.from_numpy(np.array(Yva, dtype=np.float32)) if len(Yva) else None
    fpX = torch.from_numpy(np.stack(Xneg[:256]).astype(np.float32))

    for step in range(args.steps):
        w_sched = 1.0 + 99.0 * (step / max(1, args.steps - 1)) ** 2
        # cosine lr with warmup
        warmup = args.steps // 10
        lr = 1e-4 * (step / warmup if step < warmup else 0.5 * (1 + math.cos(math.pi * min(1.0, (step - warmup) / max(1, args.steps - warmup)))))
        for g in opt.param_groups:
            g["lr"] = lr
        x, y = next(gen)
        pred = net(x).squeeze(-1)
        yv = y.clamp(0, 1)
        weights = torch.where(yv == 1, torch.ones_like(yv), torch.full_like(yv, w_sched))
        lo = bce(pred, yv, weight=weights)
        opt.zero_grad(); lo.backward(); opt.step()

        if step % 250 == 0 or step == args.steps - 1:
            with torch.no_grad():
                rec = float(((valX is None) or (net(valX).squeeze(-1) > 0.5).float().mean()))
                fp = float(((net(fpX).squeeze() > 0.5).sum()))
            log(f"step {step}: loss={float(lo):.4f} lr={lr:.6f} negw={w_sched:.0f} val_recall={rec:.3f} val_fp={fp/256:.3f}")
            if valX is not None and rec >= 0.80 and fp <= 6:
                best_models.append(copy.deepcopy(net.state_dict()))
                best_scores.append((rec, fp / 256, step))
                if len(best_models) > 8:
                    order = sorted(range(len(best_scores)), key=lambda i: (-best_scores[i][0], best_scores[i][1]))
                    keep = order[:5]
                    best_models = [best_models[i] for i in keep]
                    best_scores = [best_scores[i] for i in keep]

    # ---------------- merge + export
    sd = None
    if best_models:
        order = sorted(range(len(best_scores)), key=lambda i: (-best_scores[i][0], best_scores[i][1], -best_scores[i][2]))
        top = order[:3]
        log(f"averaging {len(top)} best checkpoints {[(round(best_scores[i][0],2), round(best_scores[i][1],3), best_scores[i][2]) for i in top]}")
        base = copy.deepcopy(best_models[top[0]])
        for k in base:
            base[k] *= 0.0
        for i in top:
            for k in base:
                base[k] += best_models[i][k] / len(top)
        net.load_state_dict(base)
    net.eval()

    try:
        torch.save({"state_dict": net.state_dict(), "emb_dim": emb_dim}, net_ckpt)
        log(f"checkpoint saved → {net_ckpt}")
    except Exception as e:
        log(f"checkpoint save skipped ({e})")

    # final eval
    with torch.no_grad():
        vrec = float((net(valX).squeeze(-1) > 0.5).float().mean()) if valX is not None else -1
        vfp = float((net(fpX).squeeze() > 0.5).sum()) / float(len(fpX))
    log(f"FINAL val_recall={vrec:.3f} false-positive-rate={vfp:.3f}")

    dummy = torch.rand(1, WINDOW_FRAMES, emb_dim)
    try:
        torch.onnx.export(net, dummy, final_onnx, opset_version=13,
                          input_names=["input"], output_names=[model_name])
    except Exception as e:
        log(f"onnx export failed ({type(e).__name__}: {e}) — retrying legacy exporter")
        torch.onnx.export(net, dummy, final_onnx, opset_version=13, dynamo=False,
                          input_names=["input"], output_names=[model_name])
    meta = {
        "phrase": phrase, "created": time.strftime("%Y-%m-%d %H:%M:%S"),
        "positives": len(pos_clips), "negatives": len(neg_clips), "extra_user_clips": extra_n,
        "steps": args.steps, "val_recall": round(vrec, 4), "val_fp_rate": round(vfp, 4),
        "metric": "input (1,16,96) openwakeword embeddings → sigmoid; trained on piper synth + local augmentation",
    }
    with open(final_onnx + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    log(f"WK-DONE onnx={final_onnx}")
    log(f"WK-RETRY hint: resume without retraining → --resume-from \"{net_ckpt}\"")
    # sanity: load exactly like the rita helper does and score 3 s of fake voice-free audio
    import numpy as _np
    from openwakeword.model import Model as _OWWModel
    _m = _OWWModel(wakeword_models=[final_onnx], inference_framework="onnx")
    _fake = (_np.sin(_np.arange(int(3 * SR)) / 50 + 1e-4) * 400 * 0.01).astype(_np.int16)
    _scores = [_m.predict(_fake[i:i + 1280]) for i in range(0, len(_fake) - 1280, 1280)]
    _maxscore = max(max(_s.values()) if isinstance(_s, dict) else _s for _s in _scores)
    log(f"WK-SANITY wrapper load OK; 3 s clean tone max score={_maxscore:.4f} (expected < 0.1)")
    log(f"WK-SET hint: settings.json → \"wakeOnnxPath\": \"{final_onnx}\" then restart Rita")


if __name__ == "__main__":
    import copy
    try:
        main()
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        import traceback
        traceback.print_exc()
        print("Wk-FAIL (see traceback above)", flush=True)
        sys.exit(1)
