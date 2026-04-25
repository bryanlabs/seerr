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
  monitorNewItems?: 'all' | 'none';
  rootFolderPath?: string;
  tags?: number[];
  images?: BookshelfAuthorImage[];
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
  editions?: {
    id?: number;
    title?: string;
    foreignEditionId?: string;
    isbn13?: string;
    asin?: string;
    format?: string;
    language?: string;
    monitored?: boolean;
  }[];
}

export interface AddBookOptions {
  foreignBookId: string;
  foreignAuthorId?: string;
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
      // added. The /book/lookup response includes the embedded author with
      // foreignAuthorId (Hardcover author id via rreading-glasses proxy). The
      // lookup endpoint resolves a specific work by foreignBookId via the
      // `work:<id>` term prefix; passing the bare id returns no results.
      const lookup = await this.searchBook(`work:${options.foreignBookId}`);
      const match =
        lookup.find((b) => b.foreignBookId === options.foreignBookId) ??
        lookup[0];

      if (!match) {
        throw new Error(
          `[Bookshelf] Lookup returned no match for ${options.foreignBookId}`
        );
      }

      const payload: Partial<BookshelfBook> & Record<string, unknown> = {
        ...match,
        qualityProfileId: options.profileId,
        metadataProfileId: options.metadataProfileId,
        rootFolderPath: options.rootFolderPath,
        monitored: options.monitored ?? true,
        author: {
          ...(match.author ?? {
            authorName: '',
            titleSlug: '',
            foreignAuthorId: '',
          }),
          qualityProfileId: options.profileId,
          metadataProfileId: options.metadataProfileId,
          rootFolderPath: options.rootFolderPath,
          monitored: options.monitored ?? true,
        },
        addOptions: {
          searchForNewBook: options.searchNow ?? true,
          addType: 'automatic',
        },
      };

      if (options.tags) {
        payload.tags = options.tags;
      }

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
      logger.error('Something went wrong while adding a book to Bookshelf.', {
        label: 'Bookshelf API',
        errorMessage: e.message,
        options,
        response: e?.response?.data,
      });
      throw new Error('Failed to add book', { cause: e });
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
