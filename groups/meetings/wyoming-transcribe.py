#!/usr/bin/env python3
"""
Wyoming protocol client for Whisper transcription using the official wyoming library.

Usage: python3 wyoming-transcribe.py <audio_file> [host] [port]
Output: transcript text to stdout
Errors: to stderr
"""
import asyncio
import os
import subprocess
import sys
import tempfile
import wave

try:
    from wyoming.asr import Transcribe, Transcript
    from wyoming.audio import AudioChunk, AudioStart, AudioStop
    from wyoming.client import AsyncTcpClient
except ImportError:
    print("Installing wyoming library...", file=sys.stderr)
    subprocess.run([sys.executable, "-m", "pip", "install", "wyoming", "-q", "--break-system-packages"], check=True)
    from wyoming.asr import Transcribe, Transcript
    from wyoming.audio import AudioChunk, AudioStart, AudioStop
    from wyoming.client import AsyncTcpClient

WYOMING_HOST = "192.168.1.25"
WYOMING_PORT = 10300
AUDIO_CHUNK_BYTES = 8192  # ~256ms at 16kHz 16-bit mono


def ensure_16k_mono(wav_path: str) -> tuple:
    """
    Return (path, is_temp). If the file is already a 16kHz/16-bit/mono WAV,
    return the original path. Otherwise convert with ffmpeg and return a temp file.
    Non-WAV formats (MP3, M4A, etc.) always go through ffmpeg.
    """
    if wav_path.lower().endswith(".wav"):
        try:
            with wave.open(wav_path, "rb") as wf:
                if wf.getframerate() == 16000 and wf.getnchannels() == 1 and wf.getsampwidth() == 2:
                    return wav_path, False
        except Exception:
            pass  # fall through to ffmpeg

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", wav_path,
                "-ar", "16000", "-ac", "1", "-sample_fmt", "s16",
                tmp.name,
            ],
            check=True,
            capture_output=True,
        )
        return tmp.name, True
    except FileNotFoundError:
        os.unlink(tmp.name)
        print("Warning: ffmpeg not found, sending original format (may affect accuracy)", file=sys.stderr)
        return wav_path, False
    except subprocess.CalledProcessError as e:
        os.unlink(tmp.name)
        print(f"Warning: ffmpeg failed ({e.stderr.decode().strip()[-200:]}), using original format", file=sys.stderr)
        return wav_path, False


async def transcribe_async(wav_path: str, host: str, port: int) -> str:
    converted_path, is_temp = ensure_16k_mono(wav_path)
    try:
        with wave.open(converted_path, "rb") as wf:
            rate = wf.getframerate()
            channels = wf.getnchannels()
            width = wf.getsampwidth()
            frames = wf.readframes(wf.getnframes())
    except Exception as e:
        raise RuntimeError(f"Failed to read WAV file: {e}") from e
    finally:
        if is_temp and os.path.exists(converted_path):
            os.unlink(converted_path)

    async with AsyncTcpClient(host, port) as client:
        await client.write_event(Transcribe(language="en").event())
        await client.write_event(AudioStart(rate=rate, width=width, channels=channels).event())

        # Send all chunks as fast as possible — Wyoming accumulates audio before transcribing
        total_chunks = (len(frames) + AUDIO_CHUNK_BYTES - 1) // AUDIO_CHUNK_BYTES
        for i, offset in enumerate(range(0, len(frames), AUDIO_CHUNK_BYTES)):
            chunk = frames[offset:offset + AUDIO_CHUNK_BYTES]
            await client.write_event(
                AudioChunk(rate=rate, width=width, channels=channels, audio=chunk).event()
            )
            if i % 200 == 0:
                print(f"Sent {i}/{total_chunks} chunks ...", file=sys.stderr)

        await client.write_event(AudioStop().event())
        print("Audio sent, waiting for transcript ...", file=sys.stderr)

        # Receive transcript — Wyoming sends one Transcript event after processing the full audio
        texts = []
        while True:
            try:
                event = await asyncio.wait_for(client.read_event(), timeout=3600.0)
            except asyncio.TimeoutError:
                print("Timed out waiting for transcript", file=sys.stderr)
                break
            except (ConnectionResetError, OSError):
                break  # server closed abruptly
            if event is None:
                break  # server closed cleanly
            if Transcript.is_type(event.type):
                t = Transcript.from_event(event)
                if t.text:
                    texts.append(t.text)
                    print(f"[transcript] {t.text[:80]}{'...' if len(t.text) > 80 else ''}", file=sys.stderr)
                break  # one Transcript per session

        return " ".join(texts)


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: wyoming-transcribe.py <audio_file> [host] [port]", file=sys.stderr)
        sys.exit(1)

    audio_file = sys.argv[1]
    host = sys.argv[2] if len(sys.argv) > 2 else WYOMING_HOST
    port = int(sys.argv[3]) if len(sys.argv) > 3 else WYOMING_PORT

    if not os.path.exists(audio_file):
        print(f"Error: file not found: {audio_file}", file=sys.stderr)
        sys.exit(1)

    print(f"Transcribing {audio_file} via {host}:{port} ...", file=sys.stderr)
    text = asyncio.run(transcribe_async(audio_file, host, port))
    print(text)


if __name__ == "__main__":
    main()
