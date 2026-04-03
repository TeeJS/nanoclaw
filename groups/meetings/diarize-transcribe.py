#!/usr/bin/env python3
"""
Diarizing transcription client for the meeting-diarizer service
(faster-whisper + pyannote.audio 3.x).

Drop-in replacement for wyoming-transcribe.py — same usage, same stdout format,
but output includes speaker labels.

Usage: python3 diarize-transcribe.py <audio_file> [service_url]
Output: speaker-labeled transcript to stdout
Errors: to stderr

Default service URL: http://192.168.1.25:10301/transcribe
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DIARIZER_URL = "http://192.168.1.25:10301/transcribe"
TIMEOUT = 3600
DEFAULT_THRESHOLD = float(os.environ.get("DIARIZER_THRESHOLD", "0.75"))


def post_audio(audio_path: str, url: str, threshold: float = DEFAULT_THRESHOLD) -> dict:
    """POST the audio file to the diarizer service as multipart/form-data."""
    boundary = "----NanoclawBoundary"
    filename = os.path.basename(audio_path)

    with open(audio_path, "rb") as f:
        audio_bytes = f.read()

    print(f"Sending {filename} ({len(audio_bytes) / 1024 / 1024:.1f} MB) to {url} ...", file=sys.stderr)

    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="audio"; filename="{filename}"\r\n'
        f"Content-Type: audio/wav\r\n"
        f"\r\n"
    ).encode() + audio_bytes + (
        f"\r\n--{boundary}\r\n"
        f'Content-Disposition: form-data; name="threshold"\r\n\r\n'
    ).encode() + str(threshold).encode() + f"\r\n--{boundary}--\r\n".encode()

    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode()}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Connection error: {e.reason}") from e

    return json.loads(raw)


def format_transcript(segments: list) -> str:
    """
    Format diarized segments into a readable speaker-labeled transcript.

    Groups consecutive segments from the same speaker into one block.
    Format:
        T.J. Schmitz: Hello everyone, thanks for joining.

        Speaker A: Thanks for having me.
    """
    if not segments:
        return ""

    lines = []
    current_speaker = None
    current_text = []

    for seg in segments:
        speaker = seg.get("speaker", "UNKNOWN").strip()
        text = seg.get("text", "").strip()

        if not text:
            continue

        if speaker != current_speaker:
            if current_speaker is not None:
                lines.append(f"{current_speaker}: {' '.join(current_text)}")
                lines.append("")
            current_speaker = speaker
            current_text = [text]
        else:
            current_text.append(text)

    # Flush last speaker
    if current_speaker is not None and current_text:
        lines.append(f"{current_speaker}: {' '.join(current_text)}")

    return "\n".join(lines)


def main() -> None:
    args = sys.argv[1:]
    if not args:
        print("Usage: diarize-transcribe.py <audio_file> [service_url] [--threshold 0.75]", file=sys.stderr)
        sys.exit(1)

    audio_file = args[0]
    url = DIARIZER_URL
    threshold = DEFAULT_THRESHOLD

    i = 1
    while i < len(args):
        if args[i] == "--threshold" and i + 1 < len(args):
            threshold = float(args[i + 1])
            i += 2
        else:
            url = args[i]
            i += 1

    if not os.path.exists(audio_file):
        print(f"Error: file not found: {audio_file}", file=sys.stderr)
        sys.exit(1)

    print(f"Using threshold: {threshold}", file=sys.stderr)

    try:
        result = post_audio(audio_file, url, threshold=threshold)
    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    segments = result.get("segments", [])
    print(f"Received {len(segments)} segments.", file=sys.stderr)

    transcript = format_transcript(segments)
    print(transcript)


if __name__ == "__main__":
    main()
