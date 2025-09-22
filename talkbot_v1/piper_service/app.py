from fastapi import FastAPI
from pydantic import BaseModel
from fastapi.responses import Response
import subprocess, tempfile, os

VOICE = "/voices/en_US-amy-medium.onnx"  # change to any downloaded voice

class In(BaseModel):
    text: str

app = FastAPI()

@app.get("/healthz")
def healthz():
    return {"ok": True}

@app.post("/synthesize")
def synthesize(inp: In):
    # synthesize to wav via piper CLI
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        out = f.name
    # piper reads text from stdin and writes wav
    cmd = ["piper", "--model", VOICE, "--output_file", out]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    p.stdin.write(inp.text.encode("utf-8"))
    p.stdin.close()
    p.wait()
    audio = open(out, "rb").read()
    os.remove(out)
    return Response(content=audio, media_type="audio/wav")
