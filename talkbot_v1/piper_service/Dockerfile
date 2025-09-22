FROM python:3.11-slim

# system deps for piper binary (lightweight set)
RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng ca-certificates wget && \
    rm -rf /var/lib/apt/lists/*

# Install piper + simple API stack
RUN pip install --no-cache-dir piper-tts fastapi uvicorn

# Grab a free English voice (Amy, medium)
RUN mkdir -p /voices && \
    wget -O /voices/en_US-amy-medium.onnx \
      "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/medium/en_US-amy-medium.onnx?download=true" && \
    wget -O /voices/en_US-amy-medium.onnx.json \
      "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/medium/en_US-amy-medium.onnx.json?download=true"

COPY app.py /app/app.py
WORKDIR /app
EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
