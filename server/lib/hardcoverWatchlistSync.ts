import { getHardcoverClient } from '@server/api/hardcover';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Not } from 'typeorm';

class HardcoverWatchlistSync {
  private isRunning = false;

  public status() {
    return { running: this.isRunning };
  }

  public cancel() {
    // Single-pass; nothing to cancel.
  }

  public async run(): Promise<void> {
    if (this.isRunning) {
      logger.debug('Hardcover watchlist sync already running, skipping', {
        label: 'HardcoverWatchlistSync',
      });
      return;
    }
    this.isRunning = true;
    try {
      const client = getHardcoverClient();
      if (!client) {
        return;
      }

      const userRepo = getRepository(User);
      const mediaRepo = getRepository(Media);
      const requestRepo = getRepository(MediaRequest);
      const settings = getSettings();

      const audiobookServer =
        settings.bookshelf.find(
          (s) => s.mediaType === 'audiobook' && s.isDefault
        ) ?? settings.bookshelf.find((s) => s.mediaType === 'audiobook');
      const ebookServer =
        settings.bookshelf.find(
          (s) => s.mediaType === 'ebook' && s.isDefault
        ) ?? settings.bookshelf.find((s) => s.mediaType === 'ebook');

      const users = await userRepo.find({});
      let createdCount = 0;
      let totalChecked = 0;

      for (const user of users) {
        const username = user.settings?.hardcoverUsername?.trim();
        if (!username) continue;
        const wantAudiobook = !!user.settings?.autoRequestAudiobooks;
        const wantEbook = !!user.settings?.autoRequestEbooks;
        if (!wantAudiobook && !wantEbook) continue;

        const wantToRead = await client.getWantToRead(username);
        if (wantToRead.length === 0) continue;
        totalChecked += wantToRead.length;

        const mediaTypes: MediaType[] = [];
        if (wantAudiobook && audiobookServer)
          mediaTypes.push(MediaType.AUDIOBOOK);
        if (wantEbook && ebookServer) mediaTypes.push(MediaType.EBOOK);
        if (mediaTypes.length === 0) continue;

        for (const book of wantToRead) {
          for (const mediaType of mediaTypes) {
            const server =
              mediaType === MediaType.AUDIOBOOK ? audiobookServer : ebookServer;
            if (!server) continue;

            // Skip if a request already exists for this book + mediaType + user.
            const existingMedia = await mediaRepo.findOne({
              where: { tmdbId: book.id, mediaType },
              relations: { requests: { requestedBy: true } },
            });
            const alreadyRequestedByUser =
              existingMedia?.requests?.some(
                (r) =>
                  r.requestedBy?.id === user.id &&
                  r.status !== MediaRequestStatus.DECLINED
              ) ?? false;
            if (alreadyRequestedByUser) continue;
            if (existingMedia?.status === MediaStatus.BLOCKLISTED) continue;
            // Skip if the book is already in the library (downloaded). The
            // Want-to-Read intent is satisfied; no need for a redundant
            // request log entry that would resolve immediately.
            if (
              existingMedia?.status === MediaStatus.AVAILABLE ||
              existingMedia?.status === MediaStatus.PARTIALLY_AVAILABLE
            ) {
              continue;
            }

            // Quota check.
            try {
              const quotas = await user.getQuota();
              const q =
                mediaType === MediaType.AUDIOBOOK
                  ? quotas.audiobook
                  : quotas.ebook;
              if (q.restricted) continue;
            } catch (e) {
              logger.warn(
                'Quota check failed during hardcover sync, skipping user',
                {
                  label: 'HardcoverWatchlistSync',
                  userId: user.id,
                  message: (e as Error).message,
                }
              );
              continue;
            }

            const media =
              existingMedia ??
              new Media({
                tmdbId: book.id,
                mediaType,
                status: MediaStatus.PENDING,
              });
            await mediaRepo.save(media);

            const autoApprove = user.hasPermission(
              [Permission.AUTO_APPROVE, Permission.MANAGE_REQUESTS],
              { type: 'or' }
            );

            const request = new MediaRequest({
              type: mediaType,
              media,
              requestedBy: user,
              status: autoApprove
                ? MediaRequestStatus.APPROVED
                : MediaRequestStatus.PENDING,
              modifiedBy: autoApprove ? user : undefined,
              is4k: false,
              serverId: server.id,
              profileId: server.activeProfileId,
              rootFolder: server.activeDirectory,
              tags: [],
              isAutoRequest: true,
            });

            // sendToBookshelf hook in MediaRequestSubscriber will fire on
            // afterInsert when status is APPROVED, mirroring the manual flow.
            await requestRepo.save(request);

            createdCount += 1;
            logger.info(
              `Auto-requested ${mediaType} "${book.title}" for ${user.email} from Hardcover want-to-read`,
              {
                label: 'HardcoverWatchlistSync',
                userId: user.id,
                hardcoverUsername: username,
                foreignBookId: book.id,
                bookSlug: book.slug,
              }
            );
          }
        }
      }

      // Quiet log unless something happened.
      if (createdCount > 0 || totalChecked > 0) {
        logger.debug(
          `Hardcover watchlist sync: ${createdCount} request(s) created from ${totalChecked} want-to-read entr${
            totalChecked === 1 ? 'y' : 'ies'
          }`,
          { label: 'HardcoverWatchlistSync' }
        );
      }

      // Used to silence unused warning if (Not) ever drops out.
      void Not;
    } catch (e) {
      logger.error('Hardcover watchlist sync failed', {
        label: 'HardcoverWatchlistSync',
        errorMessage: (e as Error).message,
      });
    } finally {
      this.isRunning = false;
    }
  }
}

const hardcoverWatchlistSync = new HardcoverWatchlistSync();
export default hardcoverWatchlistSync;
