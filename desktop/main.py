import webview
import threading
import uvicorn
import os
import sys

def run_backend():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    uvicorn.run("backend.app.main:app", host="127.0.0.1", port=8000, log_level="info")

if __name__ == "__main__":
    t = threading.Thread(target=run_backend, daemon=True)
    t.start()
    webview.create_window("Model AI", "http://127.0.0.1:8000", width=1400, height=900)
    webview.start()