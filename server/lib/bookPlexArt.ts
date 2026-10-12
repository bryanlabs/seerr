import { getHardcoverClient } from '@server/api/hardcover';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { MoreThan } from 'typeorm';

// Bryanlabs fork: Plex Audiobooks uses the `none` agent, so a requested
// audiobook shows blank album and author tiles until someone posts art.
// After Bookshelf imports a requested audiobook, post its Hardcover cover to
// the Plex album and to the author when either has no real image, then check
// it by downloading. Recent books are rechecked every sync until Plex has
// scanned them, so nothing needs to be remembered between runs.

const RECENT_DAYS = 7;
const MIN_IMAGE_BYTES = 8 * 1024;
const TIMEOUT_MS = 15_000;
const done = new Set<number>();

type PlexItem = {
  ratingKey: string;
  title: string;
  parentTitle?: string;
  parentRatingKey?: string;
  thumb?: string;
  parentThumb?: string;
};

const titleKey = (title: string): string =>
  title
    .toLowerCase()
    .replace(/^\d+\s+/, '')
    .split(/:| - /)[0]
    .replace(/[^a-z0-9]/g, '');

const surname = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .trim()
    .split(/\s+/)
    .pop() ?? '';

export const isRealImage = (bytes: Buffer): boolean =>
  bytes.length >= MIN_IMAGE_BYTES &&
  ((bytes[0] === 0xff && bytes[1] === 0xd8) ||
    bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));

export const matchAlbum = (
  albums: PlexItem[],
  title: string,
  author: string
): PlexItem | undefined => {
  const want = titleKey(title);
  const last = surname(author);
  return albums.find(
    (a) =>
      titleKey(a.title) === want &&
      (!last || (a.parentTitle ?? '').toLowerCase().includes(last))
  );
};

class PlexClient {
  constructor(
    private base: string,
    private token: string
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(this.base + path, {
      ...init,
      headers: {
        'X-Plex-Token': this.token,
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async audiobookSection(): Promise<string | undefined> {
    const res = await this.call('/library/sections');
    const body = (await res.json()) as {
      MediaContainer: { Directory?: { key: string; title: string }[] };
    };
    return body.MediaContainer.Directory?.find(
      (d) => d.title.toLowerCase() === 'audiobooks'
    )?.key;
  }

  async albums(section: string): Promise<PlexItem[]> {
    const res = await this.call(`/library/sections/${section}/all?type=9`);
    const body = (await res.json()) as {
      MediaContainer: { Metadata?: PlexItem[] };
    };
    return body.MediaContainer.Metadata ?? [];
  }

  async hasRealImage(thumb: string | undefined): Promise<boolean> {
    if (!thumb) return false;
    const res = await this.call(thumb, { headers: { Accept: 'image/*' } });
    if (!res.ok) return false;
    return isRealImage(Buffer.from(await res.arrayBuffer()));
  }

  async thumbOf(ratingKey: string): Promise<string | undefined> {
    const res = await this.call(`/library/metadata/${ratingKey}`);
    const body = (await res.json()) as {
      MediaContainer: { Metadata?: PlexItem[] };
    };
    return body.MediaContainer.Metadata?.[0]?.thumb;
  }

  async postPoster(ratingKey: string, image: Buffer): Promise<boolean> {
    const res = await this.call(`/library/metadata/${ratingKey}/posters`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: new Uint8Array(image),
    });
    return res.ok;
  }
}

async function fetchCover(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return isRealImage(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

async function plexClient(): Promise<PlexClient | null> {
  const settings = getSettings();
  if (!settings.plex?.ip) return null;
  const admin = await getRepository(User).findOne({
    select: { id: true, plexToken: true },
    where: { id: 1 },
  });
  if (!admin?.plexToken) return null;
  const protocol = settings.plex.useSsl ? 'https' : 'http';
  return new PlexClient(
    `${protocol}://${settings.plex.ip}:${settings.plex.port}`,
    admin.plexToken
  );
}

export async function postRecentAudiobookArt(): Promise<void> {
  const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const recent = await getRepository(Media).find({
    where: {
      mediaType: MediaType.AUDIOBOOK,
      status: MediaStatus.AVAILABLE,
      mediaAddedAt: MoreThan(since),
    },
  });
  if (recent.length === 0) return;

  const hardcover = getHardcoverClient();
  const plex = await plexClient();
  if (!hardcover || !plex) return;
  const section = await plex.audiobookSection();
  if (!section) return;
  const albums = await plex.albums(section);

  for (const media of recent) {
    if (done.has(media.tmdbId)) continue;
    const detail = await hardcover.getBookFullDetail(media.tmdbId);
    if (!detail?.image?.url) continue;
    const author = detail.contributions[0]?.author?.name ?? '';
    const album = matchAlbum(albums, detail.title, author);
    if (!album) continue;

    const targets = [
      { key: album.ratingKey, thumb: album.thumb, kind: 'album' },
      ...(album.parentRatingKey
        ? [
            {
              key: album.parentRatingKey,
              thumb: album.parentThumb,
              kind: 'author',
            },
          ]
        : []),
    ];
    const missing = [];
    for (const t of targets) {
      if (!(await plex.hasRealImage(t.thumb))) missing.push(t);
    }
    if (missing.length === 0) {
      done.add(media.tmdbId);
      continue;
    }

    const cover = await fetchCover(detail.image.url);
    if (!cover) {
      logger.warn('Hardcover cover is missing or too small for Plex', {
        label: 'BookPlexArt',
        tmdbId: media.tmdbId,
        title: detail.title,
      });
      continue;
    }
    for (const t of missing) {
      const posted = await plex.postPoster(t.key, cover);
      const verified =
        posted && (await plex.hasRealImage(await plex.thumbOf(t.key)));
      logger.info(
        `${verified ? 'Posted' : 'Failed to post'} ${t.kind} art for ${detail.title}`,
        { label: 'BookPlexArt', tmdbId: media.tmdbId, ratingKey: t.key }
      );
    }
  }
}
