FROM python:3.13-slim

WORKDIR /app

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

# Install Python deps
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source
COPY backend/ .

# Default port
EXPOSE 8000

# Run (project root is /app, so from app.main works)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
