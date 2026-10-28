import csv
import json
import subprocess
import sys
import tomllib
import urllib.request
from collections import Counter
from datetime import datetime
from pathlib import Path

import numpy as np
import pyloudnorm

AUDIO_TYPES = {".wav", ".m4a", ".mp3"}
HERE = Path(__file__).parent


def probe(path):
    """Ask ffprobe for the file's format facts, like reading a tape box label."""
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate,channels,bits_per_sample,bit_rate:format=duration",
         "-of", "json", str(path)],
        capture_output=True, text=True,
    )
    info = json.loads(result.stdout)
    stream = info["streams"][0]
    return {
        "type": path.suffix.lower().lstrip("."),
        "sample_rate": int(stream["sample_rate"]),
        "bit_depth": stream["bits_per_sample"],
        "channels": stream["channels"],
        "bitrate_kbps": int(stream["bit_rate"]) // 1000 if "bit_rate" in stream else None,
        "duration_s": float(info["format"]["duration"]),
    }


def decode(path, channels):
    """Ask ffmpeg to play the file into memory as samples between -1.0 and 1.0."""
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-acodec", "pcm_f32le", "-"],
        capture_output=True,
    )
    return np.frombuffer(result.stdout, dtype=np.float32).reshape(-1, channels)


def to_db(value):
    return 20 * np.log10(max(value, 1e-10))


def bandwidth(samples, rate, floor_db):
    """Highest frequency within floor_db of the loudest one, like freezing a spectrum analyser."""
    mono = samples.mean(axis=1)
    size = 4096
    usable = len(mono) // size * size
    if usable == 0:
        return None
    power = np.zeros(size // 2 + 1)
    window = np.hanning(size)
    for start in range(0, usable, size * 256):  # 256 slices at a time, to save memory
        block = mono[start:min(start + size * 256, usable)].reshape(-1, size) * window
        power += np.sum(np.abs(np.fft.rfft(block, axis=1)) ** 2, axis=0)
    if power.max() == 0:
        return 0
    strong = np.nonzero(power > power.max() * 10 ** (-floor_db / 10))[0]
    return int(strong[-1] * rate / size)


def measure(samples, rate, spec):
    """Silence share, peak, clipped samples and loudness, like reading the meters."""
    window = int(rate * 0.1)  # 100 ms slices
    usable = len(samples) // window * window
    slices = samples[:usable].reshape(-1, window * samples.shape[1])
    slice_rms = np.sqrt(np.mean(slices.astype(np.float64) ** 2, axis=1))
    silent = slice_rms < 10 ** (spec["silence_threshold_dbfs"] / 20)
    silence_share = float(silent.mean()) if len(silent) else 1.0

    peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
    clipped = int(np.sum(np.abs(samples) >= 10 ** (spec["clip_level_dbfs"] / 20)))

    try:
        loudness = pyloudnorm.Meter(rate).integrated_loudness(samples)
    except ValueError:  # shorter than one 0.4 s loudness block
        loudness = None
    return {
        "silence_share": round(silence_share, 3),
        "peak_dbfs": round(to_db(peak), 1),
        "clipped_samples": clipped,
        "loudness_lufs": None if loudness is None else round(float(loudness), 1),
        "bandwidth_hz": bandwidth(samples, rate, spec["bandwidth_floor_db"]),
    }


def check(facts, spec):
    """Compare every measurement with the spec. Each broken rule becomes a reason."""
    reasons = []
    if facts["type"] not in spec["allowed_types"]:
        reasons.append(f"type {facts['type']} not allowed")
    if facts["sample_rate"] < spec["min_sample_rate"]:
        reasons.append(f"sample rate {facts['sample_rate']} Hz below {spec['min_sample_rate']}")
    if facts["type"] == "wav" and facts["bit_depth"] < spec["min_bit_depth"]:
        reasons.append(f"bit depth {facts['bit_depth']} below {spec['min_bit_depth']}")
    if facts["type"] != "wav" and facts["bitrate_kbps"] is not None \
            and facts["bitrate_kbps"] < spec["min_bitrate_kbps"]:
        reasons.append(f"bitrate {facts['bitrate_kbps']} kbps below {spec['min_bitrate_kbps']}")
    if facts["channels"] not in spec["allowed_channels"]:
        reasons.append(f"{facts['channels']} channels")
    if facts["duration_s"] < spec["min_duration_s"]:
        reasons.append(f"too short ({facts['duration_s']:.1f} s)")
    if facts["duration_s"] > spec["max_duration_s"]:
        reasons.append(f"too long ({facts['duration_s'] / 60:.1f} min)")
    if facts["silence_share"] > spec["max_silence_share"]:
        reasons.append(f"{facts['silence_share']:.0%} silent")
    if facts["clipped_samples"] > 0:
        reasons.append(f"{facts['clipped_samples']} samples at full scale")
    bw = facts["bandwidth_hz"]
    if bw is not None and bw < spec["min_bandwidth_hz"]:
        reasons.append(f"bandwidth {bw} Hz below {spec['min_bandwidth_hz']}")
    loudness = facts["loudness_lufs"]
    if loudness is None:
        reasons.append("too short to measure loudness")
    elif loudness < spec["min_loudness_lufs"]:
        reasons.append(f"too quiet ({loudness} LUFS)")
    elif loudness > spec["max_loudness_lufs"]:
        reasons.append(f"too loud ({loudness} LUFS)")
    return reasons


FILE_COLUMNS = [  # sheet header, and which measurement goes under it
    ("File", "file"), ("Result", "result"), ("Why flagged", "reasons"), ("Type", "type"),
    ("Sample rate (Hz)", "sample_rate"), ("Bit depth", "bit_depth"), ("Channels", "channels"),
    ("Bitrate (kbps)", "bitrate_kbps"), ("Duration (s)", "duration_s"), ("Silent (%)", "silence_share"),
    ("Peak (dBFS)", "peak_dbfs"), ("Clipped samples", "clipped_samples"),
    ("Loudness (LUFS)", "loudness_lufs"), ("Bandwidth (Hz)", "bandwidth_hz"),
]
REASON_KINDS = {  # words in a reason -> short label for "most common flag reason"
    "type": "wrong file type", "sample rate": "low sample rate", "bit depth": "low bit depth",
    "bitrate": "low bitrate", "channels": "wrong channels", "measure loudness": "too short",
    "too short": "too short", "too long": "too long", "silent": "mostly silent",
    "full scale": "clipping", "too quiet": "too quiet", "too loud": "too loud", "bandwidth": "low bandwidth",
}


def send_to_sheet(rows, spec, folder):
    """Post this run to the Google Sheet, like an n8n webhook feeding an Append Row node."""
    url_file = HERE / "sheet_url.txt"
    if not url_file.exists():
        return
    run = datetime.now().strftime("%Y-%m-%d %H:%M")
    kinds = Counter(next(label for word, label in REASON_KINDS.items() if word in reason)
                    for row in rows for reason in row["reasons"].split("; ") if reason)
    top = f"{kinds.most_common(1)[0][0]} ({kinds.most_common(1)[0][1]})" if kinds else ""
    passed = sum(row["result"] == "PASS" for row in rows)
    hours = sum(row["duration_s"] for row in rows) / 3600
    tables = {
        "Runs": {"headers": ["Run time", "Folder", "Files", "Passed", "Flagged", "Pass rate",
                             "Audio (hours)", "Most common flag reason"],
                 "rows": [[run, folder.name, len(rows), passed, len(rows) - passed,
                           passed / len(rows), round(hours, 2), top]]},
        "Files": {"headers": ["Run time"] + [header for header, _ in FILE_COLUMNS],
                  "rows": [[run] + [cell(key, row[key]) for _, key in FILE_COLUMNS] for row in rows]},
        "Rules": {"headers": ["Run time", "Folder", "Rule", "Value"],
                  "rows": [[run, folder.name, key, ", ".join(map(str, value)) if isinstance(value, list) else value]
                           for key, value in spec.items()]},
    }
    request = urllib.request.Request(url_file.read_text().strip(), data=json.dumps(tables).encode(),
                                     headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(request, timeout=60)
        print("Sent to Google Sheet.")
    except OSError as error:
        print(f"Could not send to Google Sheet: {error}")


def cell(key, value):
    """Blank instead of None, and duration to one decimal, so the sheet reads cleanly."""
    if value is None:
        return ""
    return round(value, 1) if key == "duration_s" else value


spec = tomllib.load(open(HERE / "spec.toml", "rb"))
folder = Path(sys.argv[1])
rows = []
for path in sorted(folder.rglob("*")):
    if path.suffix.lower() not in AUDIO_TYPES:
        continue
    facts = probe(path)
    facts.update(measure(decode(path, facts["channels"]), facts["sample_rate"], spec))
    reasons = check(facts, spec)
    result = "FLAG" if reasons else "PASS"
    name = str(path.relative_to(folder))
    print(f"{result}  {name}  {'; '.join(reasons)}")
    rows.append({"file": name, "result": result, "reasons": "; ".join(reasons), **facts})

report = HERE / "qc_report.csv"
with open(report, "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=rows[0].keys())
    writer.writeheader()
    writer.writerows(rows)

passed = sum(row["result"] == "PASS" for row in rows)
print(f"\n{passed} of {len(rows)} files passed. Report saved to {report}")
send_to_sheet(rows, spec, folder)
