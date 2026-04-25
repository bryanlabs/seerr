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
