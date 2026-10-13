"""
device_utils.py — centralized inference-device detection & enforcement.

ROOT CAUSE this addresses (Task 1: high CPU despite "GPU" config):
  The engine previously chose its device purely from ``torch.cuda.is_available()``
  with a *silent* fall back to CPU. On a machine where the installed torch /
  ctranslate2 wheels are CPU-only (very common on Windows when torch is pulled in
  transitively without the CUDA index URL), CUDA is simply "not available", so
  BOTH models load on the CPU. faster-whisper / CTranslate2 then default to using
  *all* CPU cores, which pins the CPU near 100% while the GPU sits idle — exactly
  the reported symptom.

This module makes device selection explicit, enforceable and observable:
  * detect CUDA for BOTH torch and ctranslate2 (they can disagree),
  * honour an explicit preference (config / env) instead of guessing,
  * refuse to silently fall back to CPU unless fallback is allowed,
  * cap CPU thread usage so a *deliberate* CPU run doesn't starve the box,
  * return a structured record the UI/logs can display.

It is intentionally dependency-light: torch / ctranslate2 / pynvml are imported
lazily inside functions so the FastAPI parent process can import this module for
diagnostics without paying the torch import cost unless it asks for it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, asdict
from typing import Optional, Dict, Any


# --------------------------------------------------------------------------- #
# Env / preference parsing
# --------------------------------------------------------------------------- #
def _truthy(val: Optional[str], default: bool = False) -> bool:
    if val is None:
        return default
    return str(val).strip().lower() in ("1", "true", "yes", "on")


def requested_device(default: str = "auto") -> str:
    """The operator's requested device: 'cuda', 'cpu' or 'auto'.

    Precedence: VAAK_DEVICE / VAAK_FORCE_DEVICE env → the passed default.
    """
    val = (os.environ.get("VAAK_DEVICE")
           or os.environ.get("VAAK_FORCE_DEVICE")
           or default or "auto")
    val = str(val).strip().lower()
    if val in ("gpu", "cuda"):
        return "cuda"
    if val in ("cpu",):
        return "cpu"
    return "auto"


def allow_cpu_fallback(default: bool = True) -> bool:
    """Whether a requested CUDA run may quietly fall back to CPU.

    Defaults to True for backward compatibility (old behaviour), but can be set
    to False (VAAK_ALLOW_CPU_FALLBACK=0) so a misconfigured GPU box fails loudly
    instead of silently melting the CPU.
    """
    return _truthy(os.environ.get("VAAK_ALLOW_CPU_FALLBACK"), default)


# --------------------------------------------------------------------------- #
# Low-level probes (lazy imports)
# --------------------------------------------------------------------------- #
def torch_cuda_available() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def ctranslate2_cuda_available() -> bool:
    """CTranslate2 (faster-whisper) has its OWN CUDA runtime, independent of torch."""
    try:
        import ctranslate2
        return int(ctranslate2.get_cuda_device_count()) > 0
    except Exception:
        return False


def _nvidia_smi_driver() -> Optional[str]:
    """CUDA *driver* version from nvidia-smi (independent of any Python package)."""
    import subprocess
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8)
        v = (out.stdout or b"").decode(errors="replace").strip().splitlines()
        return v[0].strip() if v else None
    except Exception:
        return None


def cuda_report() -> Dict[str, Any]:
    """Full CUDA-stack diagnostic that explains WHY torch may not see the GPU.

    This is the Task 1 detector — it does not just print ``False``; it identifies
    the concrete cause (CPU-only wheel, driver missing, no GPU, DLL/runtime issue)
    and the exact remedy. Safe to call from the API process.
    """
    rep: Dict[str, Any] = {
        "torch_installed": False, "torch_version": None, "torch_cuda_build": None,
        "torch_cuda_available": False, "cudnn_enabled": None, "cudnn_version": None,
        "device_count": 0, "gpu_name": None, "compute_capability": None,
        "ct2_cuda": ctranslate2_cuda_available(),
        "driver_version": _nvidia_smi_driver(),
        "diagnosis": "", "recommended_fix": "", "inference_ok": False,
    }
    try:
        import torch
        rep["torch_installed"] = True
        rep["torch_version"] = torch.__version__
        rep["torch_cuda_build"] = torch.version.cuda          # None on a CPU wheel
        rep["torch_cuda_available"] = bool(torch.cuda.is_available())
        try:
            rep["cudnn_enabled"] = bool(torch.backends.cudnn.enabled)
            rep["cudnn_version"] = torch.backends.cudnn.version()
        except Exception:
            pass
        try:
            rep["device_count"] = torch.cuda.device_count()
            if rep["torch_cuda_available"]:
                rep["gpu_name"] = torch.cuda.get_device_name(0)
                cc = torch.cuda.get_device_capability(0)
                rep["compute_capability"] = f"{cc[0]}.{cc[1]}"
        except Exception:
            pass
    except Exception as e:
        rep["diagnosis"] = f"PyTorch is not importable: {e}"
        rep["recommended_fix"] = "Install PyTorch with CUDA (see pytorch.org)."
        return rep

    if not rep["gpu_name"]:
        rep["gpu_name"] = gpu_name()

    # ---- Diagnosis --------------------------------------------------- #
    is_cpu_wheel = ("+cpu" in (rep["torch_version"] or "")) or (rep["torch_cuda_build"] is None)
    driver = rep["driver_version"]
    if rep["torch_cuda_available"]:
        rep["diagnosis"] = "PyTorch CUDA is available and enabled."
        rep["inference_ok"] = True
    elif is_cpu_wheel:
        rep["diagnosis"] = (
            f"PyTorch is a CPU-ONLY build ({rep['torch_version']}, torch.version.cuda=None). "
            "It physically cannot use the GPU, so Transformers/HF models run on the CPU "
            "(this is the ~140 s/chunk bottleneck). CTranslate2 models still use the GPU "
            "via their own bundled CUDA runtime."
        )
        cu = "cu121"
        rep["recommended_fix"] = (
            f"Reinstall a CUDA build of PyTorch in this venv, e.g.:\n"
            f"  pip uninstall -y torch torchaudio\n"
            f"  pip install torch torchaudio --index-url https://download.pytorch.org/whl/{cu}\n"
            f"OR (works immediately, no reinstall): point both feeds at the CtRanslate2 "
            f"models (e.g. run_ct2 / run_prompt_ct2), which already run on the GPU."
        )
    elif not driver:
        rep["diagnosis"] = ("No NVIDIA driver detected by nvidia-smi. The GPU/driver is not "
                            "visible to this machine or session.")
        rep["recommended_fix"] = "Install/enable the NVIDIA driver; verify `nvidia-smi` works."
    else:
        rep["diagnosis"] = ("A CUDA-enabled PyTorch is installed and a driver is present, but "
                            "no CUDA device is available — check CUDA_VISIBLE_DEVICES, a CUDA "
                            "runtime/DLL mismatch, or that another process isn't hiding the GPU.")
        rep["recommended_fix"] = ("Verify CUDA_VISIBLE_DEVICES is not empty and the torch CUDA "
                                  "version matches the installed driver/runtime.")
    # CTranslate2 can still carry the day for faster-whisper models.
    if rep["ct2_cuda"] and not rep["inference_ok"]:
        rep["inference_ok"] = True  # GPU inference possible via CTranslate2
    return rep


def format_cuda_block(rep: Dict[str, Any]) -> str:
    """Operator-facing startup block for the CUDA stack (Task 1)."""
    def yn(v):
        return "Enabled" if v else "Disabled"
    lines = [
        "", "-" * 40,
        f"CUDA Driver      : {rep.get('driver_version') or 'Not found'}",
        f"PyTorch          : {rep.get('torch_version') or 'not installed'}",
        f"PyTorch CUDA     : {yn(rep.get('torch_cuda_available'))} (build cuda={rep.get('torch_cuda_build')})",
        f"Torch Device     : {'cuda:0' if rep.get('torch_cuda_available') else 'cpu'}",
        f"GPU              : {rep.get('gpu_name') or 'None'}",
        f"Compute Capabil. : {rep.get('compute_capability') or 'n/a'}",
        f"cuDNN            : {yn(rep.get('cudnn_enabled'))} (v{rep.get('cudnn_version')})",
        f"CTranslate2 CUDA : {yn(rep.get('ct2_cuda'))}",
        f"Inference on GPU : {'YES' if rep.get('inference_ok') else 'NO (CPU!)'}",
        "-" * 40,
        f"Diagnosis: {rep.get('diagnosis')}",
    ]
    if rep.get("recommended_fix"):
        lines.append(f"Fix: {rep['recommended_fix']}")
    lines.append("-" * 40)
    return "\n".join(lines)


def gpu_name() -> Optional[str]:
    # Prefer torch (accurate device name); fall back to pynvml.
    try:
        import torch
        if torch.cuda.is_available():
            return torch.cuda.get_device_name(0)
    except Exception:
        pass
    try:
        import pynvml
        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        raw = pynvml.nvmlDeviceGetName(handle)
        return raw.decode() if isinstance(raw, bytes) else str(raw)
    except Exception:
        return None


def gpu_memory() -> Dict[str, float]:
    """Return {total_gb, used_gb, free_gb} for GPU 0, or zeros if unavailable."""
    try:
        import pynvml
        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        info = pynvml.nvmlDeviceGetMemoryInfo(handle)
        gb = 1024 ** 3
        return {
            "total_gb": round(info.total / gb, 2),
            "used_gb": round(info.used / gb, 2),
            "free_gb": round(info.free / gb, 2),
        }
    except Exception:
        return {"total_gb": 0.0, "used_gb": 0.0, "free_gb": 0.0}


# --------------------------------------------------------------------------- #
# Thread capping (prevents CPU oversubscription)
# --------------------------------------------------------------------------- #
def cpu_thread_cap(default: int = 4) -> int:
    """How many CPU threads a CPU-bound inference/preprocess step may use.

    With two feeds each running their own subprocess, letting each grab every
    core is what drives 100% CPU. Cap it (VAAK_CPU_THREADS overrides).
    """
    try:
        n = int(os.environ.get("VAAK_CPU_THREADS", default))
        return max(1, n)
    except Exception:
        return default


def apply_thread_caps(threads: Optional[int] = None) -> int:
    """Cap thread pools AND stop OpenMP spin-waiting. Returns the applied count.

    Call once at process startup BEFORE heavy numeric work. Safe if torch is
    absent. Only sets env vars if not already set by the operator.

    Why this matters even on GPU (Task 1 root cause): with the default OpenMP
    wait policy, torch / CTranslate2 / MKL worker threads *busy-wait* (spin at
    100%) between the many short, frequent inferences this pipeline issues. That
    pins every core near 100% CPU while the GPU does the actual math — exactly the
    reported symptom. OMP_WAIT_POLICY=PASSIVE + KMP_BLOCKTIME=0 make idle worker
    threads sleep instead of spin, and capping the pool prevents oversubscription
    when two feed subprocesses run side by side.
    """
    n = threads if threads and threads > 0 else cpu_thread_cap()
    os.environ.setdefault("OMP_NUM_THREADS", str(n))
    os.environ.setdefault("MKL_NUM_THREADS", str(n))
    os.environ.setdefault("OPENBLAS_NUM_THREADS", str(n))
    os.environ.setdefault("NUMEXPR_NUM_THREADS", str(n))
    # Stop OpenMP/MKL worker threads from spinning at 100% while idle.
    os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")
    os.environ.setdefault("KMP_BLOCKTIME", "0")
    try:
        import torch
        torch.set_num_threads(n)
    except Exception:
        pass
    return n


# --------------------------------------------------------------------------- #
# The decision
# --------------------------------------------------------------------------- #
@dataclass
class DevicePlan:
    device: str                 # "cuda" or "cpu" — the resolved device
    torch_device: str           # "cuda" / "cpu" (for HF pipeline: use index)
    torch_index: int            # 0 for cuda, -1 for cpu (HF pipeline convention)
    compute_type: str           # ctranslate2 compute type ("float16" / "int8")
    cuda_available: bool        # torch OR ctranslate2 sees CUDA
    torch_cuda: bool
    ct2_cuda: bool
    requested: str              # "cuda" / "cpu" / "auto"
    cpu_fallback: bool          # True if we fell back to CPU from a cuda request
    gpu_name: Optional[str]
    gpu_memory: Dict[str, float]
    cpu_threads: int
    reason: str                 # human-readable explanation

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def resolve_device(prefer: str = "auto",
                   fallback: Optional[bool] = None) -> DevicePlan:
    """Decide the inference device and how each backend should be configured.

    ``prefer`` — 'cuda' | 'cpu' | 'auto' (env VAAK_DEVICE overrides).
    ``fallback`` — allow CPU fallback from a cuda request (env overrides).
    """
    prefer = requested_device(prefer)
    if fallback is None:
        fallback = allow_cpu_fallback()

    torch_cuda = torch_cuda_available()
    ct2_cuda = ctranslate2_cuda_available()
    any_cuda = torch_cuda or ct2_cuda
    threads = cpu_thread_cap()

    if prefer == "cpu":
        device, cpu_fallback = "cpu", False
        reason = "CPU explicitly requested (VAAK_DEVICE=cpu)."
    elif prefer == "cuda":
        if any_cuda:
            device, cpu_fallback = "cuda", False
            reason = "CUDA requested and available."
        elif fallback:
            device, cpu_fallback = "cpu", True
            reason = ("CUDA requested but NOT available (torch_cuda=%s, ct2_cuda=%s); "
                      "falling back to CPU because fallback is allowed." % (torch_cuda, ct2_cuda))
        else:
            device, cpu_fallback = "cpu", True
            reason = ("CUDA requested but NOT available and fallback is DISABLED. "
                      "Refusing to run on CPU — install CUDA-enabled torch/ctranslate2.")
    else:  # auto
        if any_cuda:
            device, cpu_fallback = "cuda", False
            reason = "Auto-selected CUDA (available)."
        else:
            device, cpu_fallback = "cpu", False
            reason = ("Auto-selected CPU — no CUDA runtime detected. If this box has "
                      "an NVIDIA GPU, the installed torch/ctranslate2 are likely CPU-only "
                      "builds. Reinstall with the CUDA index URL.")

    return DevicePlan(
        device=device,
        torch_device=device,
        torch_index=0 if device == "cuda" else -1,
        compute_type=("float16" if device == "cuda" else "int8"),
        cuda_available=any_cuda,
        torch_cuda=torch_cuda,
        ct2_cuda=ct2_cuda,
        requested=prefer,
        cpu_fallback=cpu_fallback,
        gpu_name=gpu_name() if device == "cuda" or any_cuda else None,
        gpu_memory=gpu_memory(),
        cpu_threads=threads,
        reason=reason,
    )


def format_startup_block(plan: DevicePlan, model_label: str = "") -> str:
    """Render the operator-facing [AI] startup block requested in Task 1."""
    mem = plan.gpu_memory or {}
    total = mem.get("total_gb", 0.0)
    lines = [
        "",
        "[AI]",
        f"CUDA Available : {'YES' if plan.cuda_available else 'NO'}",
        "",
        "GPU",
        f"{plan.gpu_name or 'None detected'}",
        "",
        "Loading Model",
        f"{model_label or '(unknown)'}",
        "",
        "Device",
        f"{plan.device}:0" if plan.device == 'cuda' else "cpu",
        "",
        "GPU Memory",
        f"{total} GB" if total else "n/a",
        "",
        "CPU Fallback",
        f"{'ENABLED (running on CPU!)' if plan.cpu_fallback else 'Disabled'}",
        "",
        f"(reason: {plan.reason})",
        "",
    ]
    return "\n".join(lines)
