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

## Sin conexión

Un service worker (`app/static/sw.js`, servido en `/sw.js` con una versión calculada
de los archivos de la app) guarda la app en el móvil y la última respuesta de cada
pantalla. Los entrenos se crean, se rellenan y se terminan en el móvil y llegan al
servidor por la cola de guardado (`POST /api/sync`) cuando hay conexión.

Los navegadores solo activan service workers en `https://` o en `localhost`.
Por `http://IP:8090` la app funciona igual, pero sin modo sin conexión.
