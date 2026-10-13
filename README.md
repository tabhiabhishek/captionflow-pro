# Model AI – ASR Model Comparison Tool

A desktop app for side‑by‑side evaluation of speech‑to‑text models.

## Setup
- Install Python dependencies: `pip install -r backend/requirements.txt`
- Install Node dependencies: `cd frontend && npm install`
- Run backend: `python backend/run.py`
- Run frontend (dev): `npm run dev` in `frontend/`
- Or run desktop wrapper: `python desktop/main.py`

## GPU inference (important)
Inference must run on a **CUDA-enabled PyTorch**. The global `python` on this box has a
CPU-only wheel (`torch 2.8.0+cpu`), which makes Transformers models run on the CPU
(~140 s/chunk). A working CUDA environment already exists at
`C:\vaakai\venv` (torch 2.6.0+cu124, transformers 5.8.1, whisperx 3.3.1, ctranslate2 4.4.0).

- `python backend/run.py` **auto-relaunches** under that CUDA venv if the current Python
  lacks CUDA torch (disable with `VAAK_NO_REEXEC=1`; override the path with `VAAK_PYTHON`).
- Regardless of how the app is launched, the caption **worker** also auto-selects a
  CUDA-capable Python (override with `VAAK_WORKER_PYTHON`), so both feeds run on the GPU.
- To run everything explicitly on GPU: `C:\vaakai\venv\Scripts\python.exe backend/run.py`.
- Verify at `GET /api/cuda` or the Dashboard → System Diagnostics → **CUDA Stack**
  (`torch_cuda_available: true`).