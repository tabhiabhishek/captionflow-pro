# speechmatics_hindi_srt

Hindi audio → **`hindi.srt`** + **`english.srt`**, both on identical timings.

Speechmatics Batch API does the Hindi ASR (paid, accurate). A free local
MarianMT model does Hindi→English. **No paid Speechmatics translation add-on
is required.**

## Data flow

```
Hindi audio (.wav .mp3 .m4a .mp4 .flac)
        │
        ├─ audio_processor  validate / pick loudest track / optional 16k mono
        ▼
   Speechmatics Batch API           (speechmatics_client.py)
        │  word-level start/end times — never invented locally
        ▼
   words_to_segments()              cue = first word's start → last word's end
        │
        ├──────────────► srt_generator ──► output/hindi.srt
        │  Segment.text only
        ▼
   translator (local MarianMT)      timings never enter this module
        │  Segment.with_text() — timing physically preserved
        ▼
        └──────────────► srt_generator ──► output/english.srt
```

**The sync guarantee.** Cue times come from Speechmatics word timings and are
carried in a frozen `Segment`. The translator only ever calls
`Segment.with_text()`, which copies the timing and replaces the words — it has
no way to produce a different timestamp. `main.py` then asserts the two lists
are equal and fails loudly if not.

## Install

```bash
cd speechmatics_hindi_srt
pip install -r requirements.txt
```

FFmpeg must be on `PATH` (or set `FFMPEG_BINARY` / `FFPROBE_BINARY`). It is
only used for probing and optional normalisation.

## API key

1. Get one at <https://portal.speechmatics.com/> → **Settings → API Keys**
2. `cp .env.example .env`
3. Edit `.env`:

```env
SPEECHMATICS_API_KEY=your_key_here
```

`.env` is gitignored. A real environment variable of the same name overrides
it (use that in CI/containers). The key is never written to code or logs — the
log line shows `abcd…wxyz (32 chars)` only in `--verbose`.

## Run

```bash
python main.py --input input/hindi_audio.wav
```

```bash
python main.py \
    --input input/hindi_audio.wav \
    --output output \
    --source-language hi \
    --target-language en

python main.py --input file.mp4 --track 2      # multi-track master
python main.py --input file.wav --no-translate # hindi.srt only
python main.py --help
```

Exit codes: `0` ok · `2` config · `3` audio · `4` ASR · `5` translation.

## Output

`output/hindi.srt`
```srt
1
00:00:00,620 --> 00:00:03,050
शादी के लिए आए मेहमानों से इस तरह बर्ताव करते हैं।

2
00:00:03,860 --> 00:00:06,200
अंगूठी गुम गई है तो दूसरी आ जाएगी।
```

`output/english.srt` — same numbers, **same timestamps**
```srt
1
00:00:00,620 --> 00:00:03,050
This is how guests come to marriage.

2
00:00:03,860 --> 00:00:06,200
If the ring is missing, the other one will come.
```

## Translation model

| | |
|---|---|
| Model | `Helsinki-NLP/opus-mt-hi-en` (MarianMT) |
| Size | ~300 MB, downloaded once |
| Cache | `%USERPROFILE%\.cache\huggingface` / `~/.cache/huggingface` |
| CPU | fine — ~20–40 cues/s |
| GPU | used automatically if `torch.cuda.is_available()` |

Swap it: `LOCAL_TRANSLATION_MODEL=<any seq2seq MT model>` in `.env`.

Add a different provider by subclassing `Translator` in `translator.py`
(`translate` + optionally `translate_batch`) and registering it in
`get_translator`. **No SRT code changes** — translators are text-in/text-out
and never see a timestamp.

Cues are batched (`TRANSLATION_BATCH_SIZE`, default 16) as a padded tensor, so
each cue maps 1:1 to its own output row. They are never concatenated into one
string, which is what would lose the cue→timestamp mapping.

## Failure handling

- Translation retries with exponential backoff (`TRANSLATION_RETRIES`, default 3)
- A failed batch falls back to per-cue translation
- A cue that still fails **keeps its slot and timing** with the original Hindi
  text, so the file never silently loses a line
- `hindi.srt` is written *before* translation starts and is never deleted —
  an ASR job you paid for cannot be lost to a translation bug

## Tests

```bash
pytest -q        # 21 tests, no API key or network needed
```

Covers timestamp conversion (`0.0`, `1.234`, `61.567`, `3661.999`, the
`59.9996 → 00:01:00,000` rounding edge, negatives), Devanagari round-trip,
empty/long/zero-length cues, overlap resolution, sequential numbering, word
grouping, punctuation attachment, retry/backoff, and — the important one —
`test_hindi_and_english_srt_have_identical_timing`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `SPEECHMATICS_API_KEY` | — | required |
| `SPEECHMATICS_LANGUAGE` | `hi` | |
| `TARGET_LANGUAGE` | `en` | |
| `TRANSLATION_BACKEND` | `local` | `local` \| `none` |
| `OUTPUT_DIR` | `output` | |
| `SPEECHMATICS_OPERATING_POINT` | `enhanced` | `standard` \| `enhanced` |
| `MAX_CUE_SECONDS` / `MAX_CUE_CHARS` | `6.0` / `84` | cue split points only — never alters a word's real time |
| `CUE_SPLIT_GAP` | `0.6` | pause that starts a new cue |
| `TRANSLATION_BATCH_SIZE` / `_RETRIES` | `16` / `3` | |
| `TRANSLATION_DEVICE` | `auto` | `auto` \| `cpu` \| `cuda` |
| `NORMALIZE_AUDIO` | `0` | force 16 kHz mono re-encode |

## Speechmatics SDK dependency

Only **`speechmatics_client.py`** touches the SDK. Written against
`speechmatics-batch` **0.5.0** (import root `speechmatics.batch`), verified by
introspecting the installed package rather than copying a doc example:

```python
AsyncClient(api_key=...)                     # async context manager
TranscriptionConfig(language=..., model=Model.ENHANCED)
await client.transcribe(path, transcription_config=..., polling_interval=, timeout=)
transcript.results                           # word + punctuation items
```

`operating_point` is deprecated in 0.5.0 in favour of `model`; the client uses
`model` and falls back automatically on older SDKs. If Speechmatics changes
again, this one file is the blast radius.

## Troubleshooting

**`SPEECHMATICS_API_KEY is not set`** — no `.env`, or you edited `.env.example`
instead of `.env`.

**`401 / authentication failed`** — key wrong, revoked, or out of credit. Check
the portal.

**`Speechmatics returned no words`** — usually the wrong `--source-language`,
or a silent audio track. On a multi-track broadcast master, most stems are
silent; the pipeline auto-picks the loudest but `--track N` overrides it.

**`ffprobe failed` / `ffmpeg failed`** — FFmpeg not on `PATH`. Set
`FFMPEG_BINARY` and `FFPROBE_BINARY` to full paths.

**Translation model download fails** — needs internet on first run. Pre-warm on
a connected machine with
`python -c "from transformers import AutoModelForSeq2SeqLM,AutoTokenizer; m='Helsinki-NLP/opus-mt-hi-en'; AutoTokenizer.from_pretrained(m); AutoModelForSeq2SeqLM.from_pretrained(m)"`,
or run `--no-translate`.

**Mojibake in a player** — files are UTF-8 **with BOM** (VLC/Premiere detect
Devanagari far more reliably that way). If your tool insists on no BOM, change
`encoding="utf-8-sig"` to `"utf-8"` in `srt_generator.write_srt`.

**`sacremoses` warning** — cosmetic; it is in `requirements.txt`.
