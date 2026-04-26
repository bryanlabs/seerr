import type {
  BookshelfAuthor,
  BookshelfAuthorImage,
  BookshelfBook,
} from '@server/api/servarr/bookshelf';
import type { MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';

export interface BookEdition {
  id?: number;
  title?: string;
  foreignEditionId?: string;
  isbn13?: string;
  asin?: string;
  format?: string;
  language?: string;
  pageCount?: number;
  monitored?: boolean;
}

export interface BookLink {
  url: string;
  name: string;
}

export interface BookAuthor {
  authorName: string;
  foreignAuthorId?: string;
  titleSlug?: string;
  overview?: string;
  remotePoster?: string;
  images?: BookshelfAuthorImage[];
}

export interface BookDetails {
  /** Bookshelf-internal id (only set once added) */
  bookshelfId?: number;
  /** Hardcover work id, used as the canonical book identifier in the URL */
  foreignBookId: string;
  /** Hardcover slug used to build hardcover.app URLs (e.g. "mistborn") */
  hardcoverSlug?: string;
  foreignEditionId?: string;
  title: string;
  overview?: string;
  authorTitle?: string;
  author?: BookAuthor;
  releaseDate?: string;
  pageCount?: number;
  remoteCover?: string;
  images?: BookshelfAuthorImage[];
  ratings?: { value?: number; votes?: number };
  genres?: string[];
  links?: BookLink[];
  editions?: BookEdition[];
  /** Raw `authorTitle` parsed into a usable name (best-effort) */
  authorName?: string;

  mediaType: MediaType.AUDIOBOOK | MediaType.EBOOK;
  mediaInfo?: Media;
}

const titleCase = (s: string): string =>
  s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Bookshelf returns `authorTitle` as a junk-formatted string like
 * "weir, andy The Martian" or
 * "baroness, orczy, emmuska orczy The Scarlet Pimpernel".
 *
 * The leading comma-separated chunk is "lastname, firstname [extras]"; we
 * try several candidates and let the caller pick the one that resolves
 * against /author/lookup.
 */
export const guessAuthorCandidates = (
  authorTitle: string | undefined,
  title: string
): string[] => {
  if (!authorTitle) return [];
  let s = authorTitle.replace(title, '').trim();
  if (s.endsWith(',')) s = s.slice(0, -1).trim();
  const out: string[] = [];

  const seen = new Set<string>();
  const push = (candidate: string) => {
    const c = titleCase(candidate.trim()).replace(/\s+/g, ' ');
    if (c && !seen.has(c.toLowerCase())) {
      seen.add(c.toLowerCase());
      out.push(c);
    }
  };

  // 1) Comma-separated form: "last, first [extra extra]"
  if (s.includes(',')) {
    const parts = s
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      // Reorder: "first last" using the first two parts
      push(`${parts[1]} ${parts[0]}`);
      // If the trailing chunk repeats the surname e.g. "orczy, emmuska orczy",
      // the third-or-later part often contains the canonical full name.
      for (let i = 2; i < parts.length; i++) push(parts[i]);
      // Also try the simple two-part reverse
      push(parts.slice().reverse().join(' '));
    }
  }

  // 2) Whole-string fallback (in case the above misses)
  push(s);

  // 3) Just the first comma-separated chunk (lastname only)
  const firstComma = s.split(',')[0]?.trim();
  if (firstComma) push(firstComma);

  return out;
};

/** Backwards-compatible: returns the first candidate or an empty string. */
export const guessAuthorName = (
  authorTitle: string | undefined,
  title: string
): string => guessAuthorCandidates(authorTitle, title)[0] ?? '';

export const mapBookDetails = (
  book: BookshelfBook,
  mediaType: BookDetails['mediaType'],
  resolvedAuthor?: BookshelfAuthor,
  media?: Media
): BookDetails => {
  const authorName =
    resolvedAuthor?.authorName ?? guessAuthorName(book.authorTitle, book.title);
  return {
    bookshelfId: book.id,
    foreignBookId: book.foreignBookId,
    hardcoverSlug: (book as BookshelfBook & { hardcoverSlug?: string })
      .hardcoverSlug,
    foreignEditionId: book.foreignEditionId,
    title: book.title,
    overview: book.overview,
    authorTitle: book.authorTitle,
    author: resolvedAuthor
      ? {
          authorName: resolvedAuthor.authorName,
          foreignAuthorId: resolvedAuthor.foreignAuthorId,
          titleSlug: resolvedAuthor.titleSlug,
          overview: resolvedAuthor.overview,
          images: resolvedAuthor.images,
        }
      : authorName
        ? { authorName }
        : undefined,
    authorName,
    releaseDate: book.releaseDate,
    pageCount: book.pageCount,
    remoteCover: book.remoteCover,
    images: book.images,
    ratings: book.ratings,
    genres: book.genres,
    links: book.links,
    editions: book.editions,
    mediaType,
    mediaInfo: media,
  };
};

interface HardcoverDetailShape {
  id: number;
  title: string;
  slug: string | null;
  release_date: string | null;
  users_count: number;
  rating: number | null;
  pages: number | null;
  description: string | null;
  image: { url: string } | null;
  cached_tags: { Genre?: { tag: string }[] } | null;
  contributions: {
    author: {
      id: number;
      name: string;
      slug: string | null;
      bio: string | null;
      image: { url: string } | null;
    } | null;
  }[];
  editions: {
    id: number;
    title: string | null;
    pages: number | null;
    release_date: string | null;
    isbn_13: string | null;
    audio_seconds: number | null;
    image: { url: string } | null;
  }[];
}

/**
 * Map the single-shot Hardcover GraphQL response to the BookDetails shape
 * the UI expects. We keep parity with the Bookshelf-mapper output so the
 * detail page renders identically — only difference is bookshelfId is
 * sourced from the local Media row (only present after a request was made)
 * instead of the synthetic Bookshelf-side id.
 */
export const mapHardcoverToBookDetails = (
  d: HardcoverDetailShape,
  mediaType: BookDetails['mediaType'],
  media?: Media
): BookDetails => {
  const primary = d.contributions
    .map((c) => c.author)
    .filter((a): a is NonNullable<typeof a> => !!a)[0];
  const authorName = primary?.name ?? '';
  const genres = (d.cached_tags?.Genre ?? []).map((g) => g.tag).filter(Boolean);
  return {
    bookshelfId: media?.externalServiceId ?? undefined,
    foreignBookId: String(d.id),
    hardcoverSlug: d.slug ?? undefined,
    foreignEditionId: d.editions?.[0]?.id
      ? String(d.editions[0].id)
      : undefined,
    title: d.title,
    overview: d.description ?? undefined,
    authorTitle: authorName ? `${authorName} ${d.title}` : undefined,
    author: primary
      ? {
          authorName: primary.name,
          foreignAuthorId: String(primary.id),
          titleSlug: primary.slug ?? undefined,
          overview: primary.bio ?? undefined,
          images: primary.image
            ? [
                {
                  coverType: 'poster',
                  url: primary.image.url,
                  remoteUrl: primary.image.url,
                },
              ]
            : undefined,
        }
      : undefined,
    authorName,
    releaseDate: d.release_date ?? undefined,
    pageCount: d.pages ?? undefined,
    remoteCover: d.image?.url ?? undefined,
    images: d.image
      ? [{ coverType: 'cover', url: d.image.url, remoteUrl: d.image.url }]
      : undefined,
    ratings:
      d.rating != null ? { value: d.rating, votes: d.users_count } : undefined,
    genres: genres.length ? genres : undefined,
    links: undefined,
    editions: d.editions?.map((e) => ({
      id: e.id,
      title: e.title ?? undefined,
      foreignEditionId: String(e.id),
      isbn13: e.isbn_13 ?? undefined,
      pageCount: e.pages ?? undefined,
      format: e.audio_seconds && e.audio_seconds > 0 ? 'audio' : undefined,
    })),
    mediaType,
    mediaInfo: media,
  };
};
