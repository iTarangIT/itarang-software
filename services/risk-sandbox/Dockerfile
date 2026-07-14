# risk-sandbox — runs agent-authored Python. Assume the code inside is hostile.
FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir --upgrade pip
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py worker.py validator.py ./

# Never run the executor as root. Combined with the read-only filesystem in
# docker-compose.yml, the worker has nowhere to write even if it escapes the
# static validator.
RUN useradd --system --no-create-home --uid 10001 sandbox
USER sandbox

EXPOSE 8000

# One worker: execution is already forked into a child process per request, and
# a single uvicorn worker keeps the memory ceiling predictable on a shared VPS.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
