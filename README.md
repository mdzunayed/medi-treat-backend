# Medi-Treat Backend

Node.js + Express + Mongoose + Multer. Backs the Flutter app's service catalog
(`/api/services`) and serves uploaded images from `/uploads/*`.

## Run with Docker (recommended)

```bash
cd backend
cp .env.example .env       # optional — docker-compose injects env directly too
docker compose up --build
```

That brings up three containers:

| Service       | URL                                | Notes                                    |
| ------------- | ---------------------------------- | ---------------------------------------- |
| api           | http://localhost:4000              | Express                                  |
| mongo         | mongodb://localhost:27018          | host port 27018 to avoid clashing with the host's mongo on 27017 |
| mongo-express | http://localhost:8081              | Web UI to browse Mongo                   |

Stop everything:

```bash
docker compose down            # keeps the volume
docker compose down -v         # drops the database too
```

## Run without Docker

```bash
cd backend
npm install
MONGO_URI=mongodb://localhost:27017/meditreat npm run dev
```

This uses your existing host mongo on 27017.

## API surface

| Method | Path                          | Body                              |
| ------ | ----------------------------- | --------------------------------- |
| GET    | `/api/services`               | optional `?active=1`              |
| POST   | `/api/services`               | multipart: `image` + form fields  |
| PUT    | `/api/services/:id`           | multipart: optional `image` + fields |
| PATCH  | `/api/services/:id/status`    | JSON `{ "status": "active" }`     |
| DELETE | `/api/services/:id`           | —                                 |
| GET    | `/uploads/<id>.jpg`           | static image                      |
| GET    | `/health`                     | `{ ok: true }`                    |

## Smoke test

```bash
curl http://localhost:4000/health
curl http://localhost:4000/api/services
```
