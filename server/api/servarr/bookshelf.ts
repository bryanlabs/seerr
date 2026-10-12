import logger from '@server/logger';
import ServarrBase from './base';

export interface BookshelfMetadataProfile {
  id: number;
  name: string;
}

export interface BookshelfAuthorImage {
  coverType: string;
  url: string;
  remoteUrl?: string;
}

export interface BookshelfAuthor {
  id?: number;
  authorName: string;
  authorNameLastFirst?: string;
  sortName?: string;
  titleSlug: string;
  overview?: string;
  path?: string;
  foreignAuthorId: string;
  metadataProfileId?: number;
  qualityProfileId?: number;
  monitored?: boolean;
  monitorNewItems?: 'all' | 'none' | 'new';
  rootFolderPath?: string;
  tags?: number[];
  images?: BookshelfAuthorImage[];
  addOptions?: {
    monitor?:
      | 'all'
      | 'future'
      | 'missing'
      | 'existing'
      | 'firstBook'
      | 'latestBook'
      | 'none';
    booksToMonitor?: string[];
    searchForMissingBooks?: boolean;
  };
}

export interface BookshelfBook {
  id?: number;
  title: string;
  titleSlug: string;
  foreignBookId: string;
  foreignEditionId?: string;
  overview?: string;
  authorTitle?: string;
  author?: BookshelfAuthor;
  authorId?: number;
  releaseDate?: string;
  pageCount?: number;
  monitored?: boolean;
  grabbed?: boolean;
  qualityProfileId?: number;
  metadataProfileId?: number;
  rootFolderPath?: string;
  addOptions?: {
    searchForNewBook?: boolean;
    addType?: 'automatic' | 'manual';
  };
  images?: BookshelfAuthorImage[];
  remoteCover?: string;
  ratings?: {
    value?: number;
    votes?: number;
    popularity?: number;
  };
  genres?: string[];
  links?: {
    url: string;
    name: string;
  }[];
  editions?: {
    id?: number;
    title?: string;
    foreignEditionId?: string;
    isbn13?: string;
    asin?: string;
    format?: string;
    language?: string;
    pageCount?: number;
    monitored?: boolean;
  }[];
  statistics?: {
    bookFileCount?: number;
    bookCount?: number;
    sizeOnDisk?: number;
    percentOfBooks?: number;
  };
}

export interface AddBookOptions {
  foreignBookId: string;
  canonicalTitle?: string;
  /**
   * Either pass an explicit foreignAuthorId or an authorName for the route to
   * resolve via /author/lookup. Bookshelf's /book/lookup response does not
   * include the author's foreignAuthorId, and it is required when POST /book.
   */
  foreignAuthorId?: string;
  authorName?: string;
  profileId: number;
  metadataProfileId: number;
  rootFolderPath: string;
  monitored?: boolean;
  tags?: number[];
  searchNow?: boolean;
}

/**
 * Bookshelf is a Readarr fork. Its API shape is v1 and mirrors Sonarr v3 for most
 * endpoints (system, qualityProfile, rootfolder, tag, queue, command) but replaces
 * the series/episode model with author/book. Two instances run in the cluster:
 * bookshelf-audiobooks and bookshelf-ebooks. This single class serves both; the
 * difference is purely the configured instance (URL + API key + default profiles).
 */
class BookshelfAPI extends ServarrBase<{
  bookId: number;
  authorId: number;
  book: BookshelfBook;
}> {
  constructor({ url, apiKey }: { url: string; apiKey: string }) {
    super({ url, apiKey, apiName: 'Bookshelf', cacheName: 'bookshelf' });
  }

  public async getBooks(): Promise<BookshelfBook[]> {
    try {
      const response = await this.axios.get<BookshelfBook[]>('/book');
      return response.data;
    } catch (e) {
      throw new Error(`[Bookshelf] Failed to retrieve books: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async getBookById(id: number): Promise<BookshelfBook> {
    try {
      const response = await this.axios.get<BookshelfBook>(`/book/${id}`);
      return response.data;
    } catch (e) {
      throw new Error(
        `[Bookshelf] Failed to retrieve book by ID: ${e.message}`,
        { cause: e }
      );
    }
  }

  public async searchBook(term: string): Promise<BookshelfBook[]> {
    try {
      const response = await this.axios.get<BookshelfBook[]>('/book/lookup', {
        params: { term },
      });
      return response.data;
    } catch (e) {
      logger.error('Error searching Bookshelf for book', {
        label: 'Bookshelf API',
        errorMessage: e.message,
        term,
      });
      throw new Error('No book found', { cause: e });
    }
  }

  public async searchAuthor(term: string): Promise<BookshelfAuthor[]> {
    try {
      const response = await this.axios.get<BookshelfAuthor[]>(
        '/author/lookup',
        { params: { term } }
      );
      return response.data;
    } catch (e) {
      logger.error('Error searching Bookshelf for author', {
        label: 'Bookshelf API',
        errorMessage: e.message,
        term,
      });
      throw new Error('No author found', { cause: e });
    }
  }

  public async getMetadataProfiles(): Promise<BookshelfMetadataProfile[]> {
    try {
      const data = await this.getRolling<BookshelfMetadataProfile[]>(
        '/metadataprofile',
        undefined,
        3600
      );
      return data;
    } catch (e) {
      throw new Error(
        `[Bookshelf] Failed to retrieve metadata profiles: ${e.message}`,
        { cause: e }
      );
    }
  }

  public async addBook(options: AddBookOptions): Promise<BookshelfBook> {
    try {
      // Bookshelf (Readarr) requires the author to exist before a book can be
      // added, but its /book/lookup response does not include the author's
      // foreignAuthorId. So we resolve the author separately via
      // /author/lookup and merge it into the POST /book payload. The book
      // lookup uses the `work:<foreignBookId>` term prefix; the bare id
      // returns no results.
      const bookLookup = await this.searchBook(`work:${options.foreignBookId}`);
      const match =
        bookLookup.find((b) => b.foreignBookId === options.foreignBookId) ??
        bookLookup[0];

      if (!match) {
        throw new Error(
          `[Bookshelf] Book lookup returned no match for ${options.foreignBookId}`
        );
      }

      const canonicalTitle = options.canonicalTitle?.trim();
      const bookTitle = canonicalTitle || match.title;
      const authorTitle =
        canonicalTitle && match.authorTitle
          ? match.authorTitle.replace(match.title, canonicalTitle)
          : match.authorTitle;

      let foreignAuthorId = options.foreignAuthorId;
      let resolvedAuthor: BookshelfAuthor | undefined;
      if (!foreignAuthorId) {
        if (!options.authorName) {
          throw new Error(
            `[Bookshelf] addBook requires either foreignAuthorId or authorName`
          );
        }
        const authorLookup = await this.searchAuthor(options.authorName);
        resolvedAuthor = authorLookup[0];
        if (!resolvedAuthor?.foreignAuthorId) {
          throw new Error(
            `[Bookshelf] Author lookup returned no match for "${options.authorName}"`
          );
        }
        foreignAuthorId = resolvedAuthor.foreignAuthorId;
      }

      // Bookshelf's BookResource mapper iterates over Editions unconditionally
      // and 500s with ArgumentNullException if the field is missing. Synthesize
      // an editions array from the lookup's foreignEditionId so the mapper has
      // something to walk.
      const editions = match.editions?.length
        ? match.editions.map((edition) => ({
            ...edition,
            title:
              canonicalTitle &&
              (!edition.title || edition.title === match.title)
                ? canonicalTitle
                : edition.title,
          }))
        : match.foreignEditionId
          ? [
              {
                foreignEditionId: match.foreignEditionId,
                title: bookTitle,
                monitored: true,
              },
            ]
          : [];

      // Mirror Bookshelf UI's "Add New Book" with Monitor=Only This Book +
      // Monitor New Books=None. Without these overrides Readarr falls back to the
      // root folder defaults (defaultMonitorOption=all, defaultNewItemMonitorOption=all)
      // and grabs the entire author bibliography.
      const payload: Partial<BookshelfBook> & Record<string, unknown> = {
        ...match,
        title: bookTitle,
        authorTitle,
        editions,
        qualityProfileId: options.profileId,
        metadataProfileId: options.metadataProfileId,
        rootFolderPath: options.rootFolderPath,
        monitored: options.monitored ?? true,
        author: {
          ...(resolvedAuthor ?? {
            authorName: options.authorName ?? '',
            titleSlug: foreignAuthorId,
            foreignAuthorId,
          }),
          foreignAuthorId,
          qualityProfileId: options.profileId,
          metadataProfileId: options.metadataProfileId,
          rootFolderPath: options.rootFolderPath,
          monitored: options.monitored ?? true,
          monitorNewItems: 'none',
          addOptions: {
            monitor: 'none',
            booksToMonitor: [options.foreignBookId],
            searchForMissingBooks: false,
          },
        },
        addOptions: {
          searchForNewBook: options.searchNow ?? true,
          addType: 'automatic',
        },
      };

      if (options.tags) {
        payload.tags = options.tags;
      }

      try {
        const response = await this.axios.post<BookshelfBook>('/book', payload);

        if (response.data.id) {
          logger.info('Bookshelf accepted request', { label: 'Bookshelf' });
        } else {
          logger.error('Failed to add book to Bookshelf', {
            label: 'Bookshelf',
            options,
          });
          throw new Error('Failed to add book to Bookshelf');
        }

        return response.data;
      } catch (e) {
        // Bookshelf returns 409 with a UNIQUE constraint failure when the
        // book/edition is already present. Treat this as success: look up the
        // existing book and trigger BookSearch so the user still gets a grab
        // attempt for any new request.
        const status = e?.response?.status;
        const body = e?.response?.data;
        const isDuplicate =
          status === 409 ||
          (typeof body?.message === 'string' &&
            /UNIQUE constraint failed/i.test(body.message));
        if (!isDuplicate) {
          throw e;
        }

        const existing = await this.findExistingBook(match.foreignBookId);
        if (!existing) {
          throw e;
        }

        if (existing.id && (options.searchNow ?? true)) {
          await this.searchBookCommand(existing.id).catch(() => undefined);
        }

        logger.info('Bookshelf book already present, treated as success', {
          label: 'Bookshelf',
          bookId: existing.id,
          foreignBookId: existing.foreignBookId,
        });
        return existing;
      }
    } catch (e) {
      logger.error('Something went wrong while adding a book to Bookshelf.', {
        label: 'Bookshelf API',
        errorMessage: e.message,
        options,
        response: e?.response?.data,
      });
      throw new Error('Failed to add book', { cause: e });
    }
  }

  private async findExistingBook(
    foreignBookId: string
  ): Promise<BookshelfBook | undefined> {
    try {
      const response = await this.axios.get<BookshelfBook[]>('/book');
      return response.data.find((b) => b.foreignBookId === foreignBookId);
    } catch {
      return undefined;
    }
  }

  public searchBookCommand = async (bookId: number): Promise<void> => {
    logger.info('Executing Bookshelf book search command.', {
      label: 'Bookshelf API',
      bookId,
    });
    try {
      await this.runCommand('BookSearch', { bookIds: [bookId] });
    } catch (e) {
      logger.error('Failed to trigger Bookshelf book search.', {
        label: 'Bookshelf API',
        errorMessage: e.message,
        bookId,
      });
    }
  };

  public removeBook = async (bookId: number): Promise<void> => {
    try {
      await this.axios.delete(`/book/${bookId}`, {
        params: { deleteFiles: true, addImportListExclusion: false },
      });
    } catch (e) {
      throw new Error(`[Bookshelf] Failed to remove book: ${e.message}`, {
        cause: e,
      });
    }
  };
}

export default BookshelfAPI;
