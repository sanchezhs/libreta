# Libreta

Registro de entrenos minimalista: rutina fija por días, series `reps × kg`, progresión y semanas de descarga.

## Desarrollo

```sh
uv sync
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8090
uv run pytest
```

Datos en `data/libreta.db` (SQLite). Copia de seguridad: copiar ese archivo.

## Docker

```sh
docker compose up -d --build   # http://localhost:8090
```
