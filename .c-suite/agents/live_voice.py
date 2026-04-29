"""
FounderOS — Local Voice Intelligence (Live Voice Mode)
=======================================================
V7 NEW MODULE — Phase 3: External Interoperability

Replaces the basic Telegram OGG voice passthrough with a real local
Whisper-based STT pipeline running entirely on M-series hardware.

Why local?
  - Privacy: Voice notes contain raw conversational data (client names,
    revenue figures, personal decisions). Cloud STT would leak this.
  - Cost: Zero. Whisper runs on your Apple Silicon for free.
  - Speed: M4 inference is fast enough for real-time transcription.

Pipeline:
  Telegram OGG → FFmpeg decode → float32 PCM → Whisper → text

Supports:
  - Push-to-talk (PTT) via Telegram voice notes
  - Direct audio file transcription
  - Optional language detection

Requirements:
  pip install openai-whisper ffmpeg-python
  (Whisper model downloads automatically on first run to ~/.cache/whisper/)
"""

import os
import sys
import logging
import tempfile
import asyncio
from pathlib import Path

sys.path.insert(0, str(os.path.dirname(__file__)))
log = logging.getLogger("LiveVoice")


# ─── Whisper Model Loader ──────────────────────────────────────────────────────
_whisper_model = None

def _load_whisper(model_size: str = "base"):
    """
    Lazy-load the Whisper model on first use.
    'base' (74M params) is fast & accurate enough for voice commands.
    Use 'small' or 'medium' for higher accuracy at the cost of speed.

    Available sizes: tiny, base, small, medium, large
    """
    global _whisper_model
    if _whisper_model is None:
        try:
            import whisper
            log.info(f"[LiveVoice] Loading Whisper '{model_size}' model (first-run download if needed)...")
            _whisper_model = whisper.load_model(model_size)
            log.info(f"[LiveVoice] Whisper '{model_size}' ready.")
        except ImportError:
            log.error("[LiveVoice] whisper not installed. Run: pip install openai-whisper")
            _whisper_model = None
    return _whisper_model


# ─── Core Transcription Engine ─────────────────────────────────────────────────
def transcribe_audio_file(
    audio_path: str | Path,
    language:   str = None,
    model_size: str = "base",
) -> str:
    """
    Transcribe any audio file (OGG, MP3, WAV, M4A) to text using local Whisper.

    Args:
        audio_path: Path to the audio file.
        language:   Optional ISO language code (e.g. 'en', 'hi'). Auto-detects if None.
        model_size: Whisper model variant. 'base' recommended for speed.

    Returns:
        Transcribed text string, or empty string on failure.
    """
    model = _load_whisper(model_size)
    if model is None:
        return ""

    try:
        audio_path = str(audio_path)
        log.info(f"[LiveVoice] Transcribing: {os.path.basename(audio_path)}")

        opts = {"language": language} if language else {}
        result = model.transcribe(audio_path, **opts)
        text   = result.get("text", "").strip()

        detected_lang = result.get("language", "unknown")
        duration      = result.get("segments", [{}])[-1].get("end", 0.0) if result.get("segments") else 0.0

        log.info(
            f"[LiveVoice] Transcription complete | "
            f"lang={detected_lang} | duration={duration:.1f}s | "
            f"chars={len(text)}"
        )
        return text

    except Exception as e:
        log.error(f"[LiveVoice] Transcription failed for {audio_path}: {e}")
        return ""


async def transcribe_telegram_voice(
    file_bytes: bytes,
    file_ext:   str = ".ogg",
    language:   str = None,
) -> str:
    """
    Async wrapper: write raw bytes from a Telegram voice note to a temp file,
    transcribe with Whisper, and return the text.

    Used by telegram_gateway.py for voice note processing.

    Args:
        file_bytes: Raw audio bytes from Telegram's getFile endpoint.
        file_ext:   File extension ('.ogg' for Telegram voice notes).
        language:   Optional language hint.

    Returns:
        Transcribed text string.
    """
    # Write to temp file (auto-deleted after)
    with tempfile.NamedTemporaryFile(suffix=file_ext, delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name

    try:
        # Run blocking transcription in thread pool to not block asyncio loop
        loop = asyncio.get_event_loop()
        text = await loop.run_in_executor(
            None,  # default ThreadPoolExecutor
            lambda: transcribe_audio_file(tmp_path, language=language)
        )
        return text
    finally:
        # Clean up temp file
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


# ─── PTT Session Manager ──────────────────────────────────────────────────────
class PTTSession:
    """
    Push-to-Talk session manager.
    In a future CLI integration, this handles real-time recording
    (press Space to record, release to transcribe).
    Currently serves as a structured wrapper for the Telegram voice flow.
    """

    def __init__(self):
        self.is_active  = False
        self.transcript = ""

    async def process_voice_note(self, file_bytes: bytes, language: str = None) -> str:
        """Process a Telegram voice note and return transcript."""
        self.is_active  = True
        self.transcript = await transcribe_telegram_voice(file_bytes, language=language)
        self.is_active  = False
        return self.transcript

    def get_last_transcript(self) -> str:
        return self.transcript


# Global PTT session (singleton)
ptt_session = PTTSession()


# ─── Quick health check ────────────────────────────────────────────────────────
def check_whisper_available() -> bool:
    """Returns True if the whisper package is importable."""
    try:
        import whisper  # noqa: F401
        return True
    except ImportError:
        return False


if __name__ == "__main__":
    # Simple CLI test: python live_voice.py <path_to_audio_file>
    import sys
    if len(sys.argv) > 1:
        path   = sys.argv[1]
        result = transcribe_audio_file(path)
        print(f"\n📝 Transcript:\n{result}")
    else:
        status = "✅ Available" if check_whisper_available() else "❌ Not installed (run: pip install openai-whisper)"
        print(f"[LiveVoice] Whisper status: {status}")
        print("Usage: python live_voice.py <audio_file>")
