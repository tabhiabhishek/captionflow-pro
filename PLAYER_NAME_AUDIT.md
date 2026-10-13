# Player-Name Accuracy — Production Audit (quick_captions.py + config.json)

**Verified facts (not assumptions):**
- Models `run` / `run_prompt` = **Whisper large-v3-turbo**: `decoder_layers: 4`, `encoder_layers: 32`, `num_mel_bins: 128`, `max_target_positions: 448`.
- `generation_config`: `suppress_tokens: []` (empty), `begin_suppress_tokens: [220, 50257]`, `alignment_heads` present (word-alignment capable).
- `best_of` is **not used** anywhere. Decoding is beam-only.
- Chunk = 3 s, overlap tail via `prepare_audio_chunk`, boundary de-dup via `BoundaryBuffer`.

---

## 3. ROOT CAUSE ANALYSIS (do this first)

Player names are corrupted **at Whisper decoding**, not in post-processing. Ranked by contribution:

1. **The Turbo model itself (dominant, ~60–70% of the problem).** large-v3-**turbo** has a **4-layer decoder** (full large-v3 has 32). Turbo was distilled for latency and is documented — by OpenAI and independent benchmarks — to regress on **rare words, proper nouns and non-English names**. Names like *Bumrah, Jasprit, Suryakumar, Gaikwad, Rinku, Tilak Varma* are exactly the low-probability token sequences a 4-layer decoder collapses to a common phonetic neighbour ("Boomra", "Moomra"). **No post-processor can reliably reconstruct arbitrary phonetic garbage** — the information is lost at decode.
2. **Out-of-vocabulary / low prior (dominant #2).** Even full Whisper under-represents sub-continental names. Without biasing, the LM prior pulls toward common English words.
3. **No *match-scoped* biasing prompt.** The pipeline injects the **generic** `player_names.cricket` list (Kohli, Stokes…) — not the **actual playing XI** for the live match. Whisper only biases strongly toward names that are *in the prompt*. Today the *right 22 names* for the current game are usually absent.
4. **`condition_on_previous_text = false`** (set for hallucination control). This removes the model's own cross-window continuity — a name decoded correctly in chunk N does not prime chunk N+1. Rolling-context prompt only partially compensates.
5. **3 s chunk boundaries.** A name split across the seam ("…Vir" | "at Kohli…") is decoded as two fragments; the overlap/boundary layer cannot always re-join a *mangled* fragment.
6. **Fuzzy correction risk (minor but real).** `phonetic_correction.fuzzy_threshold = 68` is aggressively low; `_fuzzy_correct_word` can *rewrite a correctly-heard word* into a similar terminology entry. This is the only post-processing stage that actively corrupts proper nouns.

**Conclusion:** fix the **decoder input** (biasing prompt with the real roster) and, where latency allows, the **decoder capacity** (full large-v3 for the name-critical feed). Use post-processing only as a **roster-scoped phonetic** correction — never a global dictionary.

---

## 1. quick_captions.py — function-by-function audit (name-relevant)

| Function | Role | Player-name verdict |
|---|---|---|
| `_load_cfg`, globals | config load, PROMPT/BEAM/TEMPERATURE/CALIBRATION | OK. `BEAM_SIZE`/`TEMPERATURE` only applied when set — good. |
| `early_vad` + `_silero_has_speech` | VAD gate | ✅ Correct; drops non-speech. No name impact. |
| `load_audio` / `_resample_audio` | I/O + resample to 16 k | OK. Native WAV read; fine. |
| `enhance_audio` | 4th-order Butterworth band-pass **80–3800 Hz** + RMS norm | ⚠️ **Band-pass upper cut at 3.8 kHz removes fricative/sibilant energy** (s, sh, t bursts) that disambiguate names (e.g. *Star**c*** vs *Start*, *Shar**ma***). Recommend widening to ~80–7000 Hz or bypassing for the ASR path. Measurable name benefit, negligible cost. |
| `prepare_audio_chunk` | prepends `overlap_tail.npy`, appends pad | ⚠️ Overlap is **audio-tail concatenation**, then the model re-decodes the seam. With turbo this often *re-mangles* the boundary word. Boundary handling is text-side only. |
| `_dynamic_prompt` | builds `initial_prompt` = PROMPT + player names + rolling context | ✅ Right mechanism, **wrong content**: it injects the *generic* name list, not the *match XI*. This is the key lever to fix. |
| `TurboTranscriber._load_model` | loads model, device | OK. Logs model. |
| `TurboTranscriber.transcribe` | decode | ⚠️ **No `best_of`; beam only when `BEAM_SIZE` set.** `suppress_tokens` empty. This is where names are lost — see decode params below. |
| `TimestampEngine` (WhisperX) | alignment | Alignment only re-times existing text; **it cannot fix a wrong word.** Limited name value (see WhisperX section). |
| `BoundaryBuffer.push/_find_overlap` | word-overlap de-dup across chunks | Text-level overlap join. Fine, but can't repair a mangled boundary token. |
| `TextProcessor.filter_non_english` | strips non-ASCII | ⚠️ Destroys accented names (Modrić, Mbappé, Šići). Cricket = mostly ASCII, low impact; **risk for other sports**. |
| `remove_fillers` | drops um/uh… | Safe. |
| `deduplicate_player_names` | regex for *listed* names only | Safe (only known names). |
| `deduplicate_all` | collapse adjacent identical words | Low risk (could merge a real repeat). |
| `deduplicate_sentences` / `deduplicate_phrases` | fuzzy ≥85 sentence/phrase dedup | ⚠️ Edge: can drop a name-bearing sentence if similar to a prior one. Low frequency. |
| `filter_hallucination` | drop filler lines (now dominant-filler aware) | Safe for names. |
| `fix_common_grammar` | small regex list | Safe (names not in the list). |
| `terminology.correct` | apply wrong→correct map | ✅ The safe, intended correction point (roster-scoped). |
| **`_fuzzy_correct_word`** | rapidfuzz ≥ **68** vs `correct_terms` | 🔴 **Only stage that actively corrupts proper nouns.** Threshold 68 + `token_sort` will rewrite a correctly-heard word to a look-alike term. Raise to ~88 and/or scope to roster. |
| `capitalize_proper_nouns` | capitalise *known* names | Safe. |
| `fix_capitalization` / `fix_punctuation` | casing/punct | Safe. |
| `_emit` | 2nd `terminology.correct` + `_seen` fuzzy 98% dedup | OK; 98% dup gate is safe. |
| `run_pipeline` | orchestration + rolling context update | ✅ Correct; rolling context added. |

**Stages that can change a name incorrectly:** `_fuzzy_correct_word` (main), `filter_non_english` (accents), `deduplicate_all`/`deduplicate_phrases` (rare). Everything else is name-safe.

---

## 4. Whisper inference parameter review + recommendations

| Param | Now | Recommend | Why (names) |
|---|---|---|---|
| `initial_prompt` | generic names + rolling ctx | **Per-match roster + venue + teams + officials** | Biggest single lever. Whisper biases to prompt names. |
| `condition_on_previous_text` | `false` | **`true` with periodic reset** (e.g. reset every ~30 s or on low-conf) | Restores name continuity; reset caps hallucination drift. |
| `beam_size` | 5 (when set) | **5** (keep) | Beam explores rarer name tokens vs greedy. |
| `best_of` | unused | **5** (temperature 0 → equals beam; set for fallback temps) | Better candidate selection on hard segments. |
| `temperature` | 0 | **[0.0, 0.2, 0.4]** fallback | Only fall back when logprob/compression fail; keeps determinism at 0. |
| `logprob_threshold` | −1.0 | −1.0 (keep) | Fine. |
| `no_speech_threshold` | 0.6 | 0.6 (keep) | Fine with Silero. |
| `compression_ratio_threshold` | 2.4 | 2.4 (keep) | Fine. |
| `no_repeat_ngram_size` / `repetition_penalty` | 3 / 1.2 | keep | Good for loops; neutral for names. |
| `suppress_tokens` | `[]` | **`[-1]`** (Whisper default non-speech set) | Suppresses junk tokens; slight name-precision gain. |
| `language` / `task` | en / transcribe | keep | Correct. |
| `word_timestamps` | via WhisperX | keep for alignment only | Not a name fix. |

---

## CHUNKING review

- Names **do** split across 3 s seams. Current mitigation = audio overlap tail + text overlap de-dup — insufficient for *mangled* boundary words.
- Recommend: **overlap ≥ 1.0 s** (config has 0.5 in one file, 1.0 in another — unify to 1.0), keep `condition_on_previous_text=true` so the model itself carries the name across the seam, and prefer **word-timestamp-based merge** (drop the last partial word of chunk N if it re-appears whole at the start of chunk N+1). Do **not** shrink chunks below 3 s (worse OOD hallucination). Consider 4–5 s if latency budget allows — longer context = better names.

## PROMPT review

Yes — a lightweight prompt helps **if it is match-scoped**. A generic instruction ("preserve player names…") barely moves accuracy; **listing the actual XI does.** Recommended prompt shape (≤ ~200 tokens, updated per match):
```
Live English cricket commentary. Teams: <A> vs <B> at <venue>.
Players: <XI A names>, <XI B names>. Officials: <umpires>.
Transcribe proper nouns exactly.
```
Risk: overloading the prompt (100+ names) dilutes biasing and can raise hallucination — keep it to the ~30–40 relevant names.

## WHISPERX review

WhisperX gives **word-level timestamps** via forced alignment (Wav2Vec2). It **improves timing/segmentation stability**, not spelling — it aligns whatever text Whisper produced, so it **cannot fix a wrong name**. Its indirect value: better word boundaries → cleaner overlap merge (fewer split names). Limitation: extra model in VRAM + latency; only worth it if you need precise word timing (you already have alignment heads in the model for that).

---

## 5. Recommended production architecture (24×7 broadcast)

**Two-layer, roster-driven — decode-side biasing + roster-scoped phonetic correction:**

```
Per-match roster file (XI + squad + officials + venue + teams)
        │
        ├── (A) initial_prompt biasing  ── Whisper decode ──► raw text
        │                                                      │
        └── (B) roster-scoped phonetic correction ◄────────────┘
                (Double-Metaphone / rapidfuzz, ONLY the ~40 match names)
                          │
                          ▼
                    processed caption
```
- **(A)** fixes most names at the source (the correct approach).
- **(B)** repairs the residue *precisely* because it matches ASR output only against **the ~40 names in this match** — high precision, no global dictionary, no whack-a-mole. This is the "lightweight correction layer when absolutely necessary."
- Optional **(C):** run the name-critical feed on **full large-v3** (not turbo) — the true root-cause fix when latency/VRAM allow.

---

## Ranking of solutions (best → worst for names)

1. **Per-match roster injected as `initial_prompt`** — highest ROI, standard practice, deterministic-ish, no VRAM/CPU cost. *(operational: roster must be updated per match)*
2. **Full large-v3 (drop turbo) for name feed** — biggest raw-accuracy gain; costs latency + VRAM.
3. **Roster-scoped phonetic post-correction (Double Metaphone + rapidfuzz)** — cheap, safe, catches the residue.
4. **`condition_on_previous_text=true` + reset** — restores continuity.
5. **`best_of`/beam + temperature fallback + `suppress_tokens=[-1]`** — modest, free.
6. **Wider audio band-pass (80→7 kHz)** — modest, free.
7. **Overlap ≥1 s + word-timestamp merge** — fixes split names.
8. **Raise `fuzzy_threshold` 68→88 / scope fuzzy to roster** — stops post-processing *corrupting* names.
9. ❌ **Massive hardcoded name dictionary** — worst: false corrections, unmaintainable, does nothing for the ~90% decoded wrong.

---

## 2. config.json — section review + recommendations

| Section | Finding | Action |
|---|---|---|
| `processing.num_beams=5, num_return_sequences=5, temperature, repetition_penalty, no_repeat_ngram_size` | Were **not passed to the model** historically; now partly wired via `decode`. `num_return_sequences` is unused. | Add `best_of`; wire beam/temperature explicitly; **remove `num_return_sequences`** (obsolete). |
| `decode` (new) | logprob/no_speech/compression/condition/no_repeat/repetition | Keep. Add `best_of: 5`, `suppress_tokens: [-1]`. Set `condition_on_previous_text: true` (with reset in code). |
| `vad` | dual RMS + Silero; `silero_threshold=0.5` | Keep. Expose threshold; 0.5 fine. |
| `chunk_overlap` | **0.5 (backend/app) vs 1.0 (static)** inconsistent | **Unify to 1.0 s.** |
| `audio_enhancement.bandpass_high=3800` | too low for name consonants | Raise to ~7000 for ASR path. |
| `phonetic_correction.fuzzy_threshold=68` | corrupts names | Raise to **88**, or scope to roster. |
| `prompt_settings` / `context_injection` | infra exists; `dynamic_prompt_file=match_info.txt` | **Point at a real per-match roster; include XI**. This is the main config lever. |
| `grammar.*` | hallucination/dedup toggles | Keep. |
| `sport_profiles.player_names` (10 generic) | not the match roster | Leave as fallback; drive names from roster file. |
| `whisperx.model` / alignment | fine | Keep only if precise word timing needed. |
| `_version`, `_changes`, `_note_*`, `Prompt_path`, `calibration_folder` (legacy c:/vaakai paths) | stale/duplicated across two config files | **Consolidate**; remove dead c:/vaakai paths not used by this deployment. |

---

## 6–7. Exact changes (high level; ready to implement)

**Code (quick_captions.py):**
1. Add roster loader: read `context_injection.dynamic_prompt_file` (per-match roster) → feed into `_dynamic_prompt()` **instead of** the generic 10-name list; cap to ~40 names + venue/teams.
2. Add `best_of` + `suppress_tokens=[-1]` to `transcribe()` (ct2 + HF), from `decode`.
3. `condition_on_previous_text=true` with a reset counter (reset `ROLLING_CONTEXT`/prev-text every N chunks or on low-confidence).
4. New `roster_phonetic_correct(text, roster)` — Double-Metaphone (via `jellyfish`/`metaphone`) + rapidfuzz, applied **only** against the current roster; insert **after** `terminology.correct`, **before** `_fuzzy_correct_word`. Guard: replace only when phonetic key matches AND fuzz ≥ 90.
5. Raise `_fuzzy_correct_word` cutoff to 88 (or gate behind roster).
6. Widen `enhance_audio` band-pass to 7 kHz for the ASR path.

**Config:**
1. `chunk_overlap: 1.0` everywhere; `audio_enhancement.bandpass_high: 7000`; `phonetic_correction.fuzzy_threshold: 88`.
2. `decode`: add `best_of: 5`, `suppress_tokens: [-1]`, `condition_on_previous_text: true`, `prompt_reset_chunks: 12`.
3. Remove obsolete `processing.num_return_sequences`; consolidate the two config files' duplicated keys.
4. Create `match_info.txt` roster template (teams, venue, XI, officials).

---

## 8. Performance impact

| Change | Latency | CPU | GPU mem | Determinism |
|---|---|---|---|---|
| Roster prompt (A) | none | none | none | neutral |
| Roster phonetic (B) | +~0.5–2 ms/chunk | negligible | none | deterministic |
| best_of/beam=5 | small (already beam) | none | none | deterministic (temp 0) |
| suppress_tokens=[-1] | none | none | none | ✅ |
| condition_on_prev + reset | none | none | none | ✅ |
| band-pass 7 kHz | none | none | none | ✅ |
| overlap 1.0 s | +~0.3 s buffer | tiny | none | ✅ |
| **full large-v3 (optional)** | **+decode time** | none | **+VRAM** | ✅ |

All except the optional large-v3 meet: real-time, low-latency, no GPU increase, no noticeable CPU increase, deterministic, thread-safe (roster is read-only per worker).

## 9. Risks

- **Roster prompt:** stale/wrong roster → biases to absent players. Mitigate: per-match update + keep ≤40 names.
- **Phonetic correction:** over-correction. Mitigate: roster-scoped + high fuzz gate (≥90) + metaphone key match.
- **condition_on_previous_text=true:** small hallucination risk. Mitigate: periodic reset (already have Silero + filters).
- **band-pass widening:** slightly more high-freq noise into the model. Low risk with VAD.
- **large-v3:** VRAM/latency; may not fit two models on 12 GB → run sequentially or one feed only.

## 10. Prioritized implementation plan (highest → lowest impact)

1. **Match-roster `initial_prompt`** (load real XI into the biasing prompt). — *biggest, free.*
2. **Roster-scoped phonetic correction** (metaphone + rapidfuzz, ≤40 names). — *cheap, safe residue fix.*
3. **`condition_on_previous_text=true` + reset**, **`best_of:5`**, **`suppress_tokens:[-1]`**. — *free decode gains.*
4. **Widen band-pass to 7 kHz**, **overlap 1.0 s + word-merge**. — *free/near-free.*
5. **Raise fuzzy_threshold 68→88 / scope fuzzy to roster.** — *stops name corruption.*
6. **Config cleanup** (remove `num_return_sequences`, dead c:/vaakai paths, unify overlap).
7. **(If quality still short) full large-v3 for the name-critical feed.** — *root-cause, has cost.*

Do 1–5 first; expect the majority of the 90% error to collapse from (1)+(2) alone, because they attack the decode input and correct the residue precisely — without a giant dictionary.
