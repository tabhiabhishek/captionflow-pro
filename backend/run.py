"""
Backend launcher.

Auto-selects a CUDA-capable Python: if this interpreter's PyTorch has no CUDA
(e.g. the global 'python' with a torch *+cpu* wheel) but a known-good CUDA venv
exists, re-launch under that interpreter. The QuickCaptions worker inherits it via
sys.executable, so both feeds then run on the GPU. Set VAAK_PYTHON to override the
preferred interpreter, or VAAK_NO_REEXEC=1 to disable this behaviour.
"""

import os
import sys
import subprocess

# The project's own venv (C:\model_ai\venv) is the only default, so the tree is
# self-contained. The legacy sibling-venv fallback was removed: it silently ran
# the app under an interpreter outside the project, and if that one lacked CUDA
# torch both feeds dropped to CPU with nothing in the log to explain it.
# Override deliberately with VAAK_PYTHON.
_PROJECT_VENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, "venv", "Scripts", "python.exe")
_PROJECT_VENV = os.path.normpath(_PROJECT_VENV)
_PREFERRED = os.environ.get("VAAK_PYTHON") or _PROJECT_VENV


def _torch_has_cuda() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _ensure_gpu_python():
    if os.environ.get("VAAK_REEXEC") == "1" or os.environ.get("VAAK_NO_REEXEC") == "1":
        return
    if _torch_has_cuda():
        return  # already on a CUDA torch — nothing to do
    try:
        same = os.path.abspath(sys.executable).lower() == os.path.abspath(_PREFERRED).lower()
    except Exception:
        same = False
    if same or not os.path.exists(_PREFERRED):
        if not os.path.exists(_PREFERRED):
            print(f"[run] No CUDA torch here and preferred interpreter not found: {_PREFERRED}")
            print("[run] Set VAAK_PYTHON to your CUDA venv python, or install a CUDA torch build.")
        return
    print(f"[run] This Python has no CUDA torch ({sys.executable}).")
    print(f"[run] Re-launching under CUDA environment: {_PREFERRED}")
    env = os.environ.copy()
    env["VAAK_REEXEC"] = "1"
    # Re-run this exact script with the preferred interpreter.
    proc = subprocess.run([_PREFERRED, os.path.abspath(__file__)] + sys.argv[1:], env=env)
    sys.exit(proc.returncode)


if __name__ == "__main__":
    _ensure_gpu_python()
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
