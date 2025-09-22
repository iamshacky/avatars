FROM python:3.11-slim

# system deps for piper binary (lightweight set)
RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng ca-certificates wget && \
    rm -rf /var/lib/apt/lists/*

# Install piper + simple API stack
RUN pip install --no-cache-dir piper-tts fastapi uvicorn

# Grab a decent free English voice (swap later if you want)
RUN mkdir -p /voices && \
    wget -O /voices/en_US-amy-medium.onnx \
      https://github.com/rhasspy/piper/releases/download/v1.2.0/en_US-amy-medium.onnx && \
    wget -O /voices/en_US-amy-medium.onnx.json \
      https://github.com/rhasspy/piper/releases/download/v1.2.0/en_US-amy-medium.onnx.json

COPY app.py /app/app.py
WORKDIR /app
EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
