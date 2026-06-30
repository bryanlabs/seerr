# seerr AGENTS.md

## What it is

BryanLabs fork of [Seerr](https://github.com/Seerr/seerr) (itself a fork of Jellyseerr/Overseerr). Seerr is a media request manager for Jellyfin/Plex/Emby integrated with Radarr and Sonarr. The BryanLabs fork adds audiobook and ebook support via Hardcover (metadata/discovery) and Bookshelf (a Readarr fork for download automation).

Current fork version: `3.2.1-bryanlabs.56`. Active branch: `feat/audiobook-ebook-support`.

## Where it is used

- Namespace: `media-suite`
- Deployment name: `overseerr` (legacy name; do not rename without updating all k8s resources, PVCs, secrets, and service names)
- Image: `ghcr.io/bryanlabs/seerr`
- Note: the Deployment is named `overseerr` but runs the BryanLabs `seerr` fork image

## BryanLabs customizations

All custom work lives on the `feat/audiobook-ebook-support` branch. None of it is upstreamed.

### New media types
`server/constants/media.ts` extends `MediaType` with `AUDIOBOOK` and `EBOOK`.
`server/constants/discover.ts` adds 6 discover slider types (popular/trending/new for each).

### Hardcover integration (metadata and discovery)
- `server/api/hardcover.ts` -- GraphQL client for Hardcover API (book search, discover, detail, author lookup). Requires `HARDCOVER_TOKEN` env var from k8s secret `rreading-glasses-hardcover-secret`. Absent token disables discover/search gracefully.
- `server/lib/hardcoverWatchlistSync.ts` -- Syncs per-user Hardcover "Want to Read" shelf into Seerr requests every 60 seconds. Uses `hardcoverUsername` from user settings.

### Bookshelf integration (download automation)
- `server/api/servarr/bookshelf.ts` -- HTTP client for Bookshelf (Readarr fork). Same pattern as `radarr.ts`/`sonarr.ts`.
- `server/lib/settings/index.ts` -- `BookshelfSettings` interface with `mediaType: 'audiobook' | 'ebook'`. Supports separate audiobook and ebook Bookshelf instances.
- `server/lib/bookshelfSync.ts` -- Polls Bookshelf every 5 minutes; promotes book Media records to AVAILABLE when `bookFileCount > 0`.
- `server/routes/settings/bookshelf.ts` -- REST CRUD for Bookshelf configs at `/api/v1/settings/bookshelf`.

### API routes
- `server/routes/audiobook.ts` -- `/api/v1/audiobook/` (search, tags, discover, profiles, request, queue, detail).
- `server/routes/ebook.ts` -- Mirror of audiobook routes for ebook type.
- Both registered in `server/routes/index.ts` with `isAuthenticated()` guard.

### Subscriber hook
`server/subscriber/MediaRequestSubscriber.ts` -- `sendToBookshelf()` fires when a book `MediaRequest` transitions to APPROVED; calls Bookshelf `addBook`, stores `externalServiceId`, marks status PROCESSING.

### Scheduled jobs (in `server/job/schedule.ts`)
- `bookshelf-sync` -- every 5 minutes
- `hardcover-watchlist-sync` -- every 60 seconds

### Database migrations
Both SQLite and PostgreSQL variants use timestamps in the `1777xxx` range (after all upstream `1770xxx`-`1773xxx` migrations):
- `1777500000000-AddBookQuotaColumns.ts` -- `audiobookQuotaLimit`, `audiobookQuotaDays`, `ebookQuotaLimit`, `ebookQuotaDays` on `user` table.
- `1777600000000-AddHardcoverWatchlistFields.ts` -- `hardcoverUsername` on `user_settings` table.

### User entity changes
- `server/entity/User.ts` -- 4 new quota columns
- `server/entity/UserSettings.ts` -- `hardcoverUsername?: string`
- `server/routes/user/usersettings.ts` -- exposes and persists `hardcoverUsername` via GET/PUT

### Frontend additions
Pages: `src/pages/audiobooks/index.tsx`, `src/pages/audiobooks/[bookId].tsx`, `src/pages/ebooks/index.tsx`, `src/pages/ebooks/[bookId].tsx`.

New components under `src/components/`:
- `BookDetails/` -- single book detail page (cover, metadata, request button, recommendations)
- `BookDiscover/` -- discover grid
- `BookFilterSlideover/` -- filter panel
- `BookRequestModal/` -- request dialog with quality profile and metadata profile selectors
- `BookSearch/` -- search results
- `Settings/BookshelfModal/` -- admin modal for Bookshelf server configs
- `Discover/BookSlider/` -- discover homepage sliders for audiobook/ebook rows

## How it works

Next.js 14 frontend (`src/`) + Express backend (`server/`), both TypeScript, built together into a single Docker image. Runtime is `node dist/index.js` on port 5055. Database is SQLite (default) or PostgreSQL. TypeORM runs migrations automatically on startup via `datasource.ts`.

## Code map (customization-relevant)

```
server/
  api/hardcover.ts              Hardcover GraphQL client
  api/servarr/bookshelf.ts      Bookshelf HTTP client
  constants/media.ts            MediaType enum (AUDIOBOOK, EBOOK added here)
  constants/discover.ts         Discover slider types (book sliders added here)
  entity/User.ts                Book quota columns
  entity/UserSettings.ts        hardcoverUsername field
  job/schedule.ts               Scheduled jobs (bookshelf-sync, hardcover-watchlist-sync)
  lib/bookshelfSync.ts          Bookshelf availability polling
  lib/hardcoverWatchlistSync.ts Hardcover shelf sync
  lib/settings/index.ts         BookshelfSettings interface
  models/Book.ts                Unified BookDetails model
  routes/audiobook.ts           /api/v1/audiobook/* routes
  routes/ebook.ts               /api/v1/ebook/* routes
  routes/index.ts               Route registration (lines 30, 35, 134, 135)
  routes/settings/bookshelf.ts  Bookshelf config CRUD
  routes/user/usersettings.ts   hardcoverUsername persistence
  subscriber/MediaRequestSubscriber.ts  sendToBookshelf() hook
  index.ts                      ignoreUndocumented: true at line 298
  migrations/                   BryanLabs migrations (1777xxx timestamps)
src/
  pages/audiobooks/             Audiobook pages
  pages/ebooks/                 Ebook pages
  components/BookDetails/       Book detail component
  components/BookDiscover/      Discover grid
  components/BookRequestModal/  Request dialog
  components/BookSearch/        Search results
  components/Settings/BookshelfModal/  Admin config
  components/Discover/BookSlider/      Discover sliders
```

## Build and deploy

Image: `ghcr.io/bryanlabs/seerr:<version>` built by `.github/workflows/ci.yml` (multi-arch amd64+arm64). For local AMD64 builds use:

```
docker buildx build --builder cloud-bryanlabs-builder --platform linux/amd64 .
```

Commits require conventional commit format (`@commitlint/config-conventional`) enforced by husky pre-commit hook. Commit signing via 1Password is required.

Key env vars (set in k8s):
- `HARDCOVER_TOKEN` -- from secret `rreading-glasses-hardcover-secret` key `hardcover-token` (optional but disables discover if absent)
- `OIDC_ENABLED`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (from secret `seerr-oidc`), `OIDC_REDIRECT_URI`, `OIDC_AUTO_LOGIN`, `SESSION_COOKIE_NAME`

Config PVC: `overseerr-config-pvc` mounted at `/app/config`.

## Gotchas

- `ignoreUndocumented: true` at `server/index.ts:298` is required because audiobook/ebook routes are not in `seerr-api.yml`. Removing it causes all book routes to return 404.
- Startup invariant check in the k8s deployment validates the `seerr-api.yml` cookie auth name against `SESSION_COOKIE_NAME` env before starting. Mismatch causes crash-loop.
- Two Bookshelf instances are required: one with `mediaType: 'audiobook'` and one with `mediaType: 'ebook'`, each marked `isDefault` for its type. Missing config causes 500 on book requests.
- `HARDCOVER_TOKEN` is optional; absent token silently disables discover and falls back to Bookshelf search only. Per-user `hardcoverWatchlistSync` is also a no-op without `hardcoverUsername` set in user settings.
- `sendToBookshelf` treats HTTP 409 as success to avoid marking already-tracked books as FAILED.
- BryanLabs migrations use `1777xxx` timestamps to sort after all upstream migrations (`1770xxx`-`1773xxx`) without colliding.
- No 4K concept for books: `is4k: false` is hardcoded on all book `MediaRequest` records.
- The k8s Deployment is named `overseerr`; all PVCs, secrets, and service names use that name. Do not rename without updating every reference.
