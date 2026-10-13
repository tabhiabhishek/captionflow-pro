# CaptionFlow Pro

**Real-time GPU speech-to-text captioning for live cricket broadcasts.**

CaptionFlow Pro takes live broadcast feeds (UDP / MPEG-TS) or uploaded media and turns commentary into accurate captions in real time. It uses WhisperX / faster-whisper on the GPU, supports **English and Hindi**, and outputs **CEA-608** broadcast captions and **SRT** files.

---

## ✨ Features

- **Live multi-feed captioning**: capture UDP/TS streams via FFmpeg and caption several feeds at once
- **Pluggable ASR backends**: WhisperX, faster-whisper, CTranslate2, Hugging Face Transformers
- **English & Hindi** models and prompts
- **Cricket-aware text correction**: terminology lists, player-name fuzzy matching (RapidFuzz), ASR misrecognition fixes
- **Clean output**: hallucination filtering, de-duplication of sentences, phrases and names, and capitalization fixes
- **Broadcast-ready formats**: CEA-608 caption timing and sanitizing, plus SRT export
- **Live dashboard**: React UI with WebSocket updates, GPU/CPU stats and CUDA diagnostics
- **Desktop wrapper** for one-click launch

## 🧱 Tech Stack

| Layer | Tech |
|---|---|
| ASR | WhisperX, faster-whisper, CTranslate2, Transformers, PyTorch (CUDA) |
| Backend | Python, FastAPI, Uvicorn, WebSockets, FFmpeg |
| Frontend | React, Vite, Tailwind CSS |
| Desktop | Python wrapper (`desktop/main.py`) |

## 📁 Project Structure

```
backend/
  app/
    asr_backends/      # 🔒 ASR engine integrations (private)
    quick_captions.py  # 🔒 core captioning pipeline (private)
    main.py            # FastAPI app
    websocket_handler.py
    ffmpeg_utils.py
  pipelines/           # 🔒 offline SRT pipeline (private)
  run.py               # backend entry point
frontend/              # React + Vite dashboard
desktop/               # desktop launcher
config/                # app & post-processing config
Terminology/           # English cricket terms & player lists
Terminology_hi/        # Hindi terminology
prompt/ prompt_hi/     # ASR prompts
```

## 🔒 Source Availability

This is a **showcase repository**. The core captioning engine, the ASR backend integrations and the processing pipelines (marked 🔒 above) are proprietary and **not included**. The dashboard, API layer and project structure are public so you can explore how the system is built.

For access, licensing or a demo, contact [@tabhiabhishek](https://github.com/tabhiabhishek).

## 🚀 Getting Started

> ⚠️ The backend will not run without the private engine modules. The steps below are for authorized users with the full source.

### Requirements
- NVIDIA GPU with CUDA 12.x
- Python 3.10+ with **CUDA-enabled PyTorch** (e.g. `torch 2.6.0+cu124`)
- Node.js 18+
- FFmpeg on your `PATH`

### 1. Clone
```bash
git clone https://github.com/tabhiabhishek/captionflow-pro.git
cd captionflow-pro
```

### 2. Backend
```bash
python -m venv venv
venv\Scripts\activate          # Windows
pip install torch --index-url https://download.pytorch.org/whl/cu124
pip install whisperx faster-whisper
pip install -r backend/requirements.txt
python backend/run.py
```

> Set `VAAK_PYTHON` to point at a CUDA-enabled Python if you want `run.py` to re-launch itself under it.
> Set `VAAK_NO_REEXEC=1` to turn that off.

### 3. Frontend
```bash
cd frontend
npm install
npm run dev
```

### 4. Desktop (optional)
```bash
python desktop/main.py
```

### Models
Model weights are **not included** in this repository because of their size. Place WhisperX / faster-whisper models in `Model/` and select them in the dashboard.

### Verify GPU
Open `GET /api/cuda`, or go to **Dashboard → System Diagnostics → CUDA Stack**, and check that `torch_cuda_available: true`.

## 📄 License
© 2026 tabhiabhishek. All rights reserved. No permission is granted to copy, modify or distribute this code without written consent.
