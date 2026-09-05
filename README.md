# Road Rules Trainer

A Spanish and English driving-test trainer with 33 thematic tickets,
956 questions and original illustrations. Answer explanations are available in
English, Spanish and Russian.

## Local development

```bash
npm ci
npm run dev
```

## Production build

```bash
npm run build
npm run preview
```

The production site is a static bundle in `dist/`.

## Docker deployment

The production image builds the Vite application and serves `dist/` with nginx.

```bash
docker build -t road-rules-trainer .
docker run -d --restart unless-stopped --name road-rules-trainer \
  -p 127.0.0.1:5050:80 road-rules-trainer
```

Pushes to `main` run `.github/workflows/deploy.yml` on an organization-level
self-hosted runner. By default the container listens on `127.0.0.1:5050`, ready
for a reverse proxy. Set the GitHub Actions repository variable
`ROAD_RULES_PORT` to change the host port, or `ROAD_RULES_BIND_ADDRESS` to expose
it on another interface.
