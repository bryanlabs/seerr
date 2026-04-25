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
 * "baroness, orczy, emmuska orczy The Scarlet Pimpernel". Strip the trailing
 * book title and the leading honorifics/commas to recover the author name.
 */
export const guessAuthorName = (
  authorTitle: string | undefined,
  title: string
): string => {
  if (!authorTitle) return '';
  let s = authorTitle.replace(title, '').trim();
  if (s.endsWith(',')) s = s.slice(0, -1).trim();
  const tokens = s.split(/[, ]+/).filter(Boolean);
  return titleCase(tokens.slice(0, 4).join(' '));
};

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
