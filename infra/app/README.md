# Lunarus Web (`https://lunarus.ru/app`)

Caddy serves this folder as a static SPA for the main site under `/app`.
The legacy `app.lunarus.ru` host redirects to the new path.

## Build (from Flutter)

From `client_flutter/`:

```bash
flutter config --enable-web
flutter build web --release \
  --base-href /app/ \
  --dart-define=API_BASE_URL=https://api.lunarus.ru
```

`--base-href /app/` is required so the generated asset URLs point to `/app/...`.
Without it, the browser will try to load files from the site root and the web client will fail to boot.

Copy build output into this folder:

```bash
rm -rf ../infra/app/*
cp -r build/web/* ../infra/app/
```

Restart compose:

```bash
docker compose up -d --build
```
