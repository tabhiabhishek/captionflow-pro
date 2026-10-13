import json
import os
import logging
from pathlib import Path
from typing import Dict, Any, List

logger = logging.getLogger("config")

# Project root = .../model_ai  (config_manager.py lives in model_ai/backend/app/)
PROJECT_ROOT = Path(__file__).resolve().parents[2]


class ModelFolderError(Exception):
    """Raised when the configured model_folder cannot be used."""


class ConfigManager:
    def __init__(self, config_path: str = "config/config.json"):
        self.config_path = self._resolve_config_path(config_path)
        self._config = self.load()

    # ------------------------------------------------------------------ #
    # Path helpers
    # ------------------------------------------------------------------ #
    def _resolve_config_path(self, config_path: str) -> Path:
        """Resolve the config file path robustly regardless of the CWD.

        Tries, in order: the path as given, relative to the CWD, and relative
        to the project root. This makes the backend start the same way whether
        launched from model_ai/, model_ai/backend/, or elsewhere.
        """
        p = Path(config_path)
        candidates = []
        if p.is_absolute():
            candidates.append(p)
        else:
            candidates.append(Path.cwd() / p)
            candidates.append(PROJECT_ROOT / p)
        for c in candidates:
            if c.exists():
                return c.resolve()
        # Fall back to the project-root location (used for save()).
        return (PROJECT_ROOT / p).resolve()

    @staticmethod
    def resolve_model_folder(raw: str) -> Path:
        """Normalise a model_folder value into an absolute Path.

        Supports forward slashes, double backslashes, ~, relative and absolute
        paths. Relative paths are resolved against the project root.
        """
        if not raw:
            raw = "./models"
        # Normalise slashes so "C:/x", "C:\\x" and "C:\x" all behave.
        cleaned = str(raw).replace("\\\\", "\\").strip()
        expanded = os.path.expanduser(os.path.expandvars(cleaned))
        p = Path(expanded)
        if not p.is_absolute():
            p = PROJECT_ROOT / p
        # normpath collapses mixed separators; resolve() makes it canonical.
        return Path(os.path.normpath(str(p)))

    # ------------------------------------------------------------------ #
    # Load / save
    # ------------------------------------------------------------------ #
    def load(self) -> Dict[str, Any]:
        logger.info("[ConfigManager] Loading configuration from %s", self.config_path)
        if not self.config_path.exists():
            logger.warning(
                "[ConfigManager] Config file not found at %s - using defaults",
                self.config_path,
            )
            return self._default_config()
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            logger.info("[ConfigManager] Configuration loaded successfully")
            logger.info("[ConfigManager] Model Folder (raw): %s", cfg.get("model_folder"))
            return cfg
        except json.JSONDecodeError as e:
            logger.error(
                "[ConfigManager] Invalid JSON in %s: %s - falling back to defaults",
                self.config_path,
                e,
            )
            return self._default_config()
        except Exception as e:  # pragma: no cover - defensive
            logger.error("[ConfigManager] Unexpected error loading config: %s", e)
            return self._default_config()

    def save(self, data: Dict[str, Any]) -> None:
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.config_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        self._config = data
        logger.info("[ConfigManager] Configuration saved to %s", self.config_path)

    def _default_config(self) -> Dict[str, Any]:
        return {
            "default_chunk_size": 3,
            "silence_threshold": 0.5,
            "prompt": "",
            "theme": "dark",
            "model_folder": "./models",
            "feeds": [
                {"id": 1, "url": "", "model": "base", "model_path": "", "prompt": "", "chunk_size": 3},
                {"id": 2, "url": "", "model": "base", "model_path": "", "prompt": "", "chunk_size": 3},
            ],
            "models": [],
        }

    def get_feed_config(self, feed_id: int) -> dict:
        for feed in self._config.get("feeds", []):
            if feed["id"] == feed_id:
                return feed
        return {}

    # ------------------------------------------------------------------ #
    # Model discovery
    # ------------------------------------------------------------------ #
    @staticmethod
    def _detect_backend(folder: Path) -> str:
        """Detect the ASR backend of a model folder without importing torch.

        'ctranslate2' if a model.bin exists (searched recursively),
        'transformers' for *.safetensors / pytorch_model.bin, else 'unknown'.
        """
        try:
            if (folder / "model.bin").exists() or next(folder.rglob("model.bin"), None):
                return "ctranslate2"
            if any(folder.glob("*.safetensors")) or (folder / "pytorch_model.bin").exists() \
                    or next(folder.rglob("*.safetensors"), None):
                return "transformers"
        except Exception:
            pass
        return "unknown"

    def get_models_list(self) -> List[Dict[str, str]]:
        """Scan model_folder for sub-directories and return them as objects.

        Returns a list of ``{"name": ..., "path": ...}`` sorted alphabetically.
        Only directories are returned; files and hidden folders are ignored.

        Raises:
            ModelFolderError: if the folder is missing, is not a directory,
                cannot be read (permissions), or another unexpected error occurs.
        """
        raw = self._config.get("model_folder", "./models")
        folder = self.resolve_model_folder(raw)

        logger.info("[ConfigManager] Model Folder: %s", raw)
        logger.info("[ConfigManager] Resolved Path: %s", folder)

        if not folder.exists():
            logger.warning("[ConfigManager] Missing folder warning: %s does not exist", folder)
            raise ModelFolderError(f"Model folder does not exist: {folder}")
        if not folder.is_dir():
            logger.warning("[ConfigManager] %s is not a directory", folder)
            raise ModelFolderError(f"Model folder is not a directory: {folder}")

        logger.info("[ConfigManager] Scanning folder...")
        models: List[Dict[str, str]] = []
        try:
            for entry in folder.iterdir():
                # Scan only directories; ignore files and hidden folders.
                if not entry.is_dir():
                    continue
                if entry.name.startswith("."):
                    continue
                # Only real model folders. model_folder now points at
                # C:/model_ai/Model, which also holds logs/, calibration/ and
                # hallucination/ — listing those as selectable "models" would
                # let an operator load a folder with no weights in it.
                # _detect_backend returns "unknown" when it finds no
                # model.bin / *.safetensors / pytorch_model.bin.
                backend = self._detect_backend(entry)
                if backend == "unknown":
                    logger.debug("[ConfigManager] skipping non-model folder: %s", entry.name)
                    continue
                models.append({
                    "name": entry.name,
                    "path": str(entry).replace("\\", "/"),
                    "backend": backend,
                })
        except PermissionError as e:
            logger.error("[ConfigManager] Permission error scanning %s: %s", folder, e)
            raise ModelFolderError(f"Permission denied reading model folder: {folder}")
        except Exception as e:  # pragma: no cover - defensive
            logger.error("[ConfigManager] Unexpected exception scanning %s: %s", folder, e)
            raise ModelFolderError(f"Unexpected error scanning model folder: {e}")

        models.sort(key=lambda m: m["name"].lower())

        logger.info("[ConfigManager] Found Models: %s", [m["name"] for m in models])
        logger.info("[ConfigManager] Model Count: %d", len(models))
        return models
