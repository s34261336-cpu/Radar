"""Visible BotHost entry point for the RadarMap bot."""

from pathlib import Path
import runpy


runpy.run_path(
    str(Path(__file__).resolve().parent / "bothost-bot" / "app.py"),
    run_name="__main__",
)