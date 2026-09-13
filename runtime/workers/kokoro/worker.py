# Kokoro TTS worker — the controllable speech engine (plan §9).
#
# Serves BOTH sides of the system:
#   POST /synthesize  runtime live speech (KokoroHttpEngine): raw PCM16 mono
#   POST /render      Evolve candidate rendering (HttpKokoroRenderer): wav + metadata
#   GET  /audio/{f}   rendered candidate audio files
#   GET  /health      model + voice info
#
# Phoneme control: a phoneme segment renders through Misaki's explicit-phoneme
# markup [display](/phonemes/), so an entity's pronunciation is forced while the
# rest of the sentence uses normal G2P. That markup surface is exactly what a
# pronunciation repair changes.

import io
import json
import os
import re
import time
import wave
from pathlib import Path

import numpy as np
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse

SAMPLE_RATE = 24000
VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
PORT = int(os.environ.get("KOKORO_PORT", "8880"))
AUDIO_DIR = Path(os.environ.get("KOKORO_AUDIO_DIR", Path(__file__).parent / "rendered"))
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI()
_pipeline = None


def pipeline():
    global _pipeline
    if _pipeline is None:
        from kokoro import KPipeline

        _pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
    return _pipeline


def voice_model_version() -> str:
    return f"kokoro-82M:{VOICE}"


def segments_to_text(segments: list[dict]) -> str:
    parts = []
    for seg in segments:
        if seg.get("kind") == "phoneme":
            display = re.sub(r"[\[\]()]", "", seg["display"])
            # Accept phonemes with or without surrounding slashes; Misaki markup
            # supplies its own, and doubled slashes corrupt the pronunciation.
            phonemes = seg["phonemes"].strip().strip("/")
            parts.append(f"[{display}](/{phonemes}/)")
        else:
            parts.append(seg.get("text", ""))
    return "".join(parts)


def synthesize(text: str) -> tuple[np.ndarray, str]:
    chunks: list[np.ndarray] = []
    phonemes: list[str] = []
    for result in pipeline()(text, voice=VOICE):
        audio = result.audio
        chunks.append(audio.numpy() if hasattr(audio, "numpy") else np.asarray(audio))
        if getattr(result, "phonemes", None):
            phonemes.append(result.phonemes)
    joined = np.concatenate(chunks) if chunks else np.zeros(1, dtype=np.float32)
    return joined.astype(np.float32), " ".join(phonemes)


def to_pcm16(audio: np.ndarray) -> bytes:
    clipped = np.clip(audio, -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


@app.get("/health")
def health():
    return {"ok": True, "voice_model_version": voice_model_version(), "sample_rate": SAMPLE_RATE}


@app.post("/synthesize")
async def synthesize_endpoint(request: Request):
    body = await request.json()
    text = segments_to_text(body.get("segments", []))
    started = time.monotonic()
    audio, _ = synthesize(text)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    return Response(
        content=to_pcm16(audio),
        media_type="application/octet-stream",
        headers={
            "x-synthesis-meta": json.dumps(
                {
                    "sample_rate": SAMPLE_RATE,
                    "voice_model_version": voice_model_version(),
                    "render_ms": elapsed_ms,
                }
            )
        },
    )


@app.post("/render")
async def render_endpoint(request: Request):
    body = await request.json()
    segments = body.get("segments", [])
    requested_version = body.get("voice_model_version")
    # Plan §6C: candidates must render on the same voice as the failing output.
    if requested_version and requested_version != voice_model_version():
        return JSONResponse(
            status_code=422,
            content={"error": f"voice mismatch: worker={voice_model_version()} requested={requested_version}"},
        )

    text = segments_to_text(segments)
    started = time.monotonic()
    audio, rendered_phonemes = synthesize(text)
    elapsed_ms = int((time.monotonic() - started) * 1000)

    name = f"cand-{int(time.time() * 1000)}-{abs(hash(text)) % 100000}.wav"
    path = AUDIO_DIR / name
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(to_pcm16(audio))

    tokens: dict[str, str] = {}
    for seg in segments:
        if seg.get("kind") == "phoneme":
            tokens[seg["entity_id"]] = seg["phonemes"]
            tokens[seg["display"]] = seg["phonemes"]

    host = request.headers.get("host", f"localhost:{PORT}")
    return {
        "audio_url": f"http://{host}/audio/{name}",
        "rendered_phonemes": rendered_phonemes,
        "rendered_tokens": tokens,
        "duration_ms": int(len(audio) / SAMPLE_RATE * 1000),
        "render_ms": elapsed_ms,
        "voice_model_version": voice_model_version(),
    }


@app.get("/audio/{name}")
def audio(name: str):
    safe = Path(name).name
    file = AUDIO_DIR / safe
    if not file.exists():
        return JSONResponse(status_code=404, content={"error": "not found"})
    return FileResponse(file, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT)
