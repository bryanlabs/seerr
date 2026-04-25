import BookshelfAPI from '@server/api/servarr/bookshelf';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';

class BookshelfSync {
  private isRunning = false;

  public status() {
    return { running: this.isRunning };
  }

  public cancel() {
    // Single-pass; nothing to cancel.
  }

  public async run(): Promise<void> {
    if (this.isRunning) {
      logger.debug('Bookshelf sync already running, skipping', {
        label: 'BookshelfSync',
      });
      return;
    }
    this.isRunning = true;
    try {
      const settings = getSettings();
      if (!settings.bookshelf || settings.bookshelf.length === 0) {
        return;
      }

      const mediaRepo = getRepository(Media);
      const inFlight = await mediaRepo.find({
        where: {
          mediaType: In([MediaType.AUDIOBOOK, MediaType.EBOOK]),
          status: In([
            MediaStatus.PENDING,
            MediaStatus.PROCESSING,
            MediaStatus.PARTIALLY_AVAILABLE,
          ]),
        },
      });

      if (inFlight.length === 0) {
        return;
      }

      logger.debug(`Polling ${inFlight.length} in-flight books`, {
        label: 'BookshelfSync',
      });

      // Cache one client per server, and pre-fetch /book once per server so
      // we issue at most one HTTP call per Bookshelf instance per run.
      const bookCache = new Map<
        number,
        Map<number, { id?: number; statistics?: { bookFileCount?: number } }>
      >();
      for (const server of settings.bookshelf) {
        try {
          const client = new BookshelfAPI({
            apiKey: server.apiKey,
            url: BookshelfAPI.buildUrl(server, '/api/v1'),
          });
          const books = await client.getBooks();
          const byId = new Map<number, (typeof books)[number]>();
          for (const b of books) {
            if (b.id) byId.set(b.id, b);
          }
          bookCache.set(server.id, byId);
        } catch (e) {
          logger.warn('Bookshelf instance unreachable during sync', {
            label: 'BookshelfSync',
            serverId: server.id,
            errorMessage: (e as Error).message,
          });
        }
      }

      let availableCount = 0;
      for (const media of inFlight) {
        if (media.serviceId == null || media.externalServiceId == null) {
          continue;
        }
        const cache = bookCache.get(media.serviceId);
        if (!cache) continue;
        const book = cache.get(media.externalServiceId);
        if (!book) continue;
        const fileCount = book.statistics?.bookFileCount ?? 0;
        if (fileCount > 0 && media.status !== MediaStatus.AVAILABLE) {
          media.status = MediaStatus.AVAILABLE;
          if (!media.mediaAddedAt) {
            media.mediaAddedAt = new Date();
          }
          await mediaRepo.save(media);
          availableCount += 1;
          logger.info(`Marked media ${media.id} as AVAILABLE from Bookshelf`, {
            label: 'BookshelfSync',
            mediaType: media.mediaType,
            tmdbId: media.tmdbId,
            externalServiceId: media.externalServiceId,
          });
        }
      }

      if (availableCount > 0) {
        logger.info(
          `Bookshelf sync flipped ${availableCount} media row(s) to AVAILABLE`,
          { label: 'BookshelfSync' }
        );
      }
    } catch (e) {
      logger.error('Bookshelf sync failed', {
        label: 'BookshelfSync',
        errorMessage: (e as Error).message,
      });
    } finally {
      this.isRunning = false;
    }
  }
}

const bookshelfSync = new BookshelfSync();
export default bookshelfSync;
