"""ElevenLabs TTS plus segmentation.

Splits a script into segments that each render to roughly 60 seconds or less of
audio, breaking only on sentence boundaries, then synthesizes each segment to an
MP3 with the configured ElevenLabs voice.
"""
import re
import wave
import contextlib
from pathlib import Path

import requests

import config

# Average speaking rate for estimating segment audio length before synthesis.
# ElevenLabs narration lands near 2.5 words/sec; we budget conservatively.
WORDS_PER_SECOND = 2.5
_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")


def split_into_segments(text, max_seconds=None):
    """Split text on sentence boundaries into <= max_seconds chunks."""
    max_seconds = max_seconds or config.MAX_SEGMENT_SECONDS
    max_words = int(max_seconds * WORDS_PER_SECOND)
    sentences = [s.strip() for s in _SENTENCE_RE.split(text.strip()) if s.strip()]
    segments, current, count = [], [], 0
    for sent in sentences:
        w = len(sent.split())
        if current and count + w > max_words:
            segments.append(" ".join(current))
            current, count = [], 0
        current.append(sent)
        count += w
    if current:
        segments.append(" ".join(current))
    return segments


def synthesize_segment(text, out_path):
    """Render one text segment to an MP3 via ElevenLabs."""
    if not config.ELEVENLABS_API_KEY:
        raise RuntimeError("ELEVENLABS_API_KEY is not set.")
    if not config.ELEVENLABS_VOICE_ID:
        raise RuntimeError("ELEVENLABS_VOICE_ID is not set.")
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{config.ELEVENLABS_VOICE_ID}"
    resp = requests.post(
        url,
        headers={
            "xi-api-key": config.ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        json={
            "text": text,
            "model_id": config.ELEVENLABS_MODEL,
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.75, "style": 0.3, "use_speaker_boost": True},
        },
        timeout=300,
    )
    if not resp.ok:
        raise RuntimeError(f"ElevenLabs {resp.status_code}: {resp.text[:300]}")
    Path(out_path).write_bytes(resp.content)
    return out_path


def generate_voiceover(script_text):
    """Split a script and synthesize each segment. Returns list of MP3 paths."""
    segments = split_into_segments(script_text)
    paths = []
    for i, seg in enumerate(segments):
        out = config.AUDIO_DIR / f"segment_{i:03d}.mp3"
        synthesize_segment(seg, out)
        paths.append(out)
        print(f"[voiceover] segment {i+1}/{len(segments)} -> {out.name} ({len(seg.split())} words)")
    return paths
