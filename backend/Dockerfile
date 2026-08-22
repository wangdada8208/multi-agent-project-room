FROM python:3.13-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
COPY alembic.ini .

# Symlink so alembic.ini's script_location=%(here)s/backend/alembic resolves
RUN mkdir -p /app/backend && ln -sfn /app/alembic /app/backend/alembic

# Create non-root user and set ownership
RUN groupadd -r appuser && useradd -r -g appuser appuser \
    && mkdir -p /app/uploads && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
