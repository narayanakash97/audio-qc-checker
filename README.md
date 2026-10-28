# Audio QC checker

A first filter for collected audio. It runs before human review and before export, so people only listen to the files that need a human.

Point it at a folder. It checks every audio file against a client spec in `spec.toml` and marks each one PASS or FLAG with the reasons. FLAG means "a human should listen", not "reject".

Checks:

1. Format: file type, sample rate, bit depth (WAV), channels
2. Length: within a minimum and maximum
3. Silence: share of 100 ms slices below a level threshold
4. Clipping: samples at or above a level near full scale
5. Loudness: integrated LUFS (ITU-R BS.1770, via pyloudnorm) within a range

It reads WAV, M4A and MP3. Files are decoded with ffmpeg, so phone recordings get measured too, not rejected.

## Try it

You need Python 3.11 or newer and ffmpeg (`brew install ffmpeg` on a Mac).

```
git clone https://github.com/narayanakash97/audio-qc-checker.git
cd audio-qc-checker
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python qc.py examples
```

`examples/` holds five synthetic test tones, one per kind of problem. Expected output:

```
PASS  01_clean_tone.wav
FLAG  02_clipped_and_too_loud.wav  30000 samples at full scale; too loud (-3.0 LUFS)
FLAG  03_mostly_silent.wav  80% silent
FLAG  04_low_sample_rate.wav  sample rate 16000 Hz below 44100
FLAG  05_too_short.wav  too short (1.0 s)

1 of 5 files passed.
```

To check your own audio, run `python qc.py /path/to/folder`. It looks inside subfolders too. Results are also written to `qc_report.csv`, with every measured value per file. Each run overwrites that file.

## Changing the spec

Every threshold lives in `spec.toml`. Change the numbers there. The code does not need to change.

## First run on real recordings

I ran it on 170 of my own recordings: about 5.9 hours of field recordings (WAV, 48 to 192 kHz) and raw iPhone voice memos (M4A). It took 68 seconds on a MacBook Air. 96 passed and 74 were flagged.

- Three voice memos were 0.2 seconds long: taps on the record button. No human should ever spend time on those.
- 29 files were too quiet, and 26 of those were ambience recordings. A -35 LUFS floor suits speech, not birdsong. One spec does not fit every kind of content.
- 19 phone memos showed samples at or above full scale after decoding, which points to a hot input. On compressed files that count is a warning sign, not an exact number.

## Ideas for the next version (not built)

1. Spec profiles per client and per content type (studio voice, in-the-wild speech, WhatsApp-grade, ambience), picked per project.
2. Run the check at upload, so a contributor can re-record straight away while they still have the mic.
3. Three outcomes instead of two: PASS, REVIEW (a human listens) and RE-RECORD (a clear failure, like a 0.2 s file or the wrong sample rate, sent back automatically).
4. Duplicate detection. My test set held 25 exact duplicate recordings under different folders.
5. Audit a random sample of PASS files with humans, to measure what the filter misses and tune thresholds on evidence.
6. Read long files in chunks. A 51-minute memo used about 3.7 GB of memory.

## Who built what

I'm an audio engineer. I wrote the spec, chose the checks and set the thresholds. An AI coding agent (Claude Code) wrote the Python. The loudness and peak readings were checked against ffmpeg's EBU R128 meter (`ebur128`) on two files and matched to within 0.1 LU.
