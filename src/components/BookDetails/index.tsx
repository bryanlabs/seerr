import Spinner from '@app/assets/spinner.svg';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Tag from '@app/components/Common/Tag';
import StatusBadge from '@app/components/StatusBadge';
import { Permission, useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import {
  ArrowDownTrayIcon,
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  CloudIcon,
  CogIcon,
  StarIcon,
} from '@heroicons/react/24/outline';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { BookDetails as BookDetailsType } from '@server/models/Book';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';

interface BookDetailsProps {
  mediaType: 'audiobook' | 'ebook';
}

const buttonLabel = (mediaType: 'audiobook' | 'ebook') =>
  mediaType === 'audiobook' ? 'Audiobook' : 'Ebook';

const BookDetails = ({ mediaType }: BookDetailsProps) => {
  const { hasPermission } = useUser();
  const { addToast } = useToasts();

  const router = useRouter();
  const id = typeof router.query.bookId === 'string' ? router.query.bookId : '';

  const apiBase =
    mediaType === 'audiobook' ? '/api/v1/audiobook' : '/api/v1/ebook';

  const { data, error, mutate } = useSWR<BookDetailsType>(
    id ? `${apiBase}/${id}` : null
  );

  const [requesting, setRequesting] = useState(false);

  if (!data && !error) {
    return <LoadingSpinner />;
  }
  if (!data) {
    return <ErrorPage statusCode={404} />;
  }

  const cover =
    data.remoteCover ??
    data.images?.find((i) => i.coverType === 'cover')?.remoteUrl ??
    data.images?.find((i) => i.coverType === 'cover')?.url;
  const year = data.releaseDate?.slice(0, 4);
  const status: MediaStatus | undefined = data.mediaInfo?.status;
  const activeRequest = data.mediaInfo?.requests?.find(
    (r) =>
      r.status === MediaRequestStatus.PENDING ||
      r.status === MediaRequestStatus.APPROVED
  );

  const submitRequest = async () => {
    setRequesting(true);
    try {
      await axios.post(`${apiBase}/request`, {
        foreignBookId: data.foreignBookId,
        authorName: data.authorName ?? data.author?.authorName,
        title: data.title,
      });
      addToast(`Requested: ${data.title}`, {
        appearance: 'success',
        autoDismiss: true,
      });
      mutate();
    } catch (e) {
      const message =
        (e as { response?: { data?: { message?: string } } }).response?.data
          ?.message ?? 'Request failed';
      addToast(message, { appearance: 'error', autoDismiss: true });
    } finally {
      setRequesting(false);
    }
  };

  const ratingValue = data.ratings?.value;
  const ratingVotes = data.ratings?.votes;

  return (
    <div className="media-page">
      <PageTitle title={data.title} />
      {cover && (
        <div className="media-page-bg-image">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={cover}
            alt=""
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: 'blur(20px) brightness(0.4)',
            }}
          />
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                'linear-gradient(180deg, rgba(17,24,39,0) 0%, rgba(17,24,39,1) 100%)',
            }}
          />
        </div>
      )}
      <div className="media-header">
        <div className="media-poster">
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cover}
              alt=""
              className="rounded-md shadow-md"
              style={{ width: '100%', height: 'auto' }}
            />
          ) : (
            <div className="aspect-[2/3] w-full rounded-md bg-gray-700" />
          )}
        </div>
        <div className="media-title">
          <div className="media-status">
            <Badge>{buttonLabel(mediaType)}</Badge>
            {status !== undefined && status !== MediaStatus.UNKNOWN && (
              <StatusBadge
                status={status}
                inProgress={false}
                mediaType={mediaType === 'audiobook' ? 'movie' : 'movie'}
              />
            )}
          </div>
          <h1>
            {data.title}
            {year && <span className="media-year"> ({year})</span>}
          </h1>
          {data.authorName && (
            <span className="media-attribute">
              <span className="text-gray-400">by </span>
              {data.authorName}
            </span>
          )}
          {data.genres && data.genres.length > 0 && (
            <span className="media-attribute mt-2 flex flex-wrap gap-1">
              {data.genres.slice(0, 6).map((g) => (
                <Tag key={g}>{g}</Tag>
              ))}
            </span>
          )}
          {ratingValue !== undefined && ratingValue > 0 && (
            <span className="media-attribute mt-2 inline-flex items-center gap-1">
              <StarIcon className="h-4 w-4 text-yellow-400" />
              <span className="text-white">{ratingValue.toFixed(2)}</span>
              {ratingVotes !== undefined && (
                <span className="text-gray-400">({ratingVotes} ratings)</span>
              )}
            </span>
          )}
        </div>
        <div className="media-actions">
          {activeRequest ? (
            <Button buttonType="success" disabled className="cursor-default">
              <CheckIcon className="mr-2 h-5 w-5" />
              Requested
            </Button>
          ) : status === MediaStatus.AVAILABLE ? (
            <Button buttonType="success" disabled className="cursor-default">
              <CheckIcon className="mr-2 h-5 w-5" />
              Available
            </Button>
          ) : status === MediaStatus.PROCESSING ? (
            <Button buttonType="primary" disabled className="cursor-default">
              <Spinner className="mr-2 h-5 w-5 animate-spin" />
              Processing
            </Button>
          ) : (
            <Button
              buttonType="primary"
              onClick={submitRequest}
              disabled={requesting}
            >
              {requesting ? (
                <Spinner className="mr-2 h-5 w-5 animate-spin" />
              ) : (
                <ArrowDownTrayIcon className="mr-2 h-5 w-5" />
              )}
              Request
            </Button>
          )}
          {data.mediaInfo?.serviceUrl &&
            hasPermission(Permission.MANAGE_REQUESTS) && (
              <a
                href={data.mediaInfo.serviceUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button buttonType="default">
                  <CogIcon className="mr-2 h-5 w-5" />
                  Open in Bookshelf
                </Button>
              </a>
            )}
          {data.mediaInfo?.mediaUrl && (
            <a
              href={data.mediaInfo.mediaUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button buttonType="default">
                <CloudIcon className="mr-2 h-5 w-5" />
                Open in Plex
              </Button>
            </a>
          )}
        </div>
      </div>
      <div className="media-overview">
        <div className="media-overview-left">
          <div className="text-2xl font-bold text-white">
            {intl('Overview')}
          </div>
          <p className="pt-2 text-lg text-gray-300">
            {data.overview ?? 'No overview available.'}
          </p>

          {data.editions && data.editions.length > 0 && (
            <div className="mt-8">
              <div className="text-2xl font-bold text-white">Editions</div>
              <ul className="mt-2 space-y-1 text-sm text-gray-400">
                {data.editions.slice(0, 8).map((e) => (
                  <li
                    key={e.foreignEditionId ?? e.title ?? Math.random()}
                    className="flex items-center gap-2"
                  >
                    <span className="text-white">{e.title ?? 'Edition'}</span>
                    {e.format && <Badge>{e.format}</Badge>}
                    {e.language && (
                      <span className="text-gray-500">{e.language}</span>
                    )}
                    {e.isbn13 && (
                      <span className="text-gray-500">ISBN {e.isbn13}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.author?.overview && (
            <div className="mt-8">
              <div className="text-2xl font-bold text-white">
                About the Author
              </div>
              <p className="pt-2 text-sm text-gray-300">
                {data.author.overview}
              </p>
            </div>
          )}
        </div>
        <div className="media-overview-right">
          <div className="media-facts">
            {data.authorName && (
              <div className="media-fact">
                <span>Author</span>
                <span className="media-fact-value">{data.authorName}</span>
              </div>
            )}
            {data.releaseDate && (
              <div className="media-fact">
                <span>Release Date</span>
                <span className="media-fact-value">
                  {data.releaseDate.slice(0, 10)}
                </span>
              </div>
            )}
            {data.pageCount !== undefined && data.pageCount > 0 && (
              <div className="media-fact">
                <span>Pages</span>
                <span className="media-fact-value">{data.pageCount}</span>
              </div>
            )}
            {data.foreignBookId && (
              <div className="media-fact">
                <span>Hardcover ID</span>
                <a
                  href={`https://hardcover.app/books/${data.foreignBookId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="media-fact-value flex items-center gap-1 hover:underline"
                >
                  {data.foreignBookId}
                  <ArrowTopRightOnSquareIcon className="h-3 w-3" />
                </a>
              </div>
            )}
            {data.bookshelfId !== undefined && (
              <div className="media-fact">
                <span>Bookshelf ID</span>
                <span className="media-fact-value">{data.bookshelfId}</span>
              </div>
            )}
          </div>
          {data.links && data.links.length > 0 && (
            <div className="mt-4 flex flex-col gap-2">
              {data.links.slice(0, 6).map((l) => (
                <a
                  key={l.url}
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-indigo-300 hover:underline"
                >
                  {l.name} ↗
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Tiny i18n helper to keep imports light. The user-facing strings are simple
// for Phase 1+ and don't need extracted message catalogs.
const intl = (s: string) => s;

export default BookDetails;
