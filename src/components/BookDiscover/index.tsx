import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import axios from 'axios';
import Link from 'next/link';
import { useEffect, useState } from 'react';

interface DiscoverHit {
  foreignBookId: string;
  title: string;
  releaseDate?: string | null;
  rating?: number | null;
  usersCount?: number;
  pageCount?: number | null;
  remoteCover?: string;
  authorTitle?: string;
  mediaInfo?: { status: number };
}

interface Props {
  mediaType: 'audiobook' | 'ebook';
}

const STATUS_LABEL: Record<
  number,
  { text: string; color: string } | undefined
> = {
  2: { text: 'Pending', color: 'bg-yellow-500' },
  3: { text: 'Processing', color: 'bg-indigo-500' },
  4: { text: 'Partially Available', color: 'bg-cyan-500' },
  5: { text: 'Available', color: 'bg-green-500' },
};

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'popularity:desc', label: 'Popularity (descending)' },
  { value: 'popularity:asc', label: 'Popularity (ascending)' },
  { value: 'title:asc', label: 'Title (A → Z)' },
  { value: 'title:desc', label: 'Title (Z → A)' },
  { value: 'release_date:desc', label: 'Release date (newest)' },
  { value: 'release_date:asc', label: 'Release date (oldest)' },
  { value: 'rating:desc', label: 'Rating (highest)' },
  { value: 'rating:asc', label: 'Rating (lowest)' },
];

const BookDiscover = ({ mediaType }: Props) => {
  const isAudio = mediaType === 'audiobook';
  const apiBase = isAudio ? '/api/v1/audiobook' : '/api/v1/ebook';
  const detailBase = isAudio ? '/audiobooks' : '/ebooks';
  const [sortKey, setSortKey] = useState('popularity:desc');
  const [hits, setHits] = useState<DiscoverHit[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const [sort, dir] = sortKey.split(':');
    let cancelled = false;
    setLoading(true);
    axios
      .get<{ results: DiscoverHit[] }>(`${apiBase}/discover`, {
        params: { sort, dir, limit: 36 },
      })
      .then((r) => {
        if (!cancelled) setHits(r.data.results ?? []);
      })
      .catch(() => {
        if (!cancelled) setHits([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, sortKey]);

  return (
    <div className="my-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">
          Popular {isAudio ? 'Audiobooks' : 'Ebooks'}
        </h2>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value)}
          className="rounded-md border border-gray-600 bg-gray-800 px-3 py-1.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {loading && !hits && <LoadingSpinner />}

      {hits && hits.length === 0 && !loading && (
        <div className="text-sm text-gray-400">
          No {isAudio ? 'audiobook' : 'ebook'} discovery results. Hardcover may
          be unreachable.
        </div>
      )}

      {hits && hits.length > 0 && (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {hits.map((b) => (
            <li key={b.foreignBookId}>
              <Link
                href={`${detailBase}/${b.foreignBookId}`}
                className="relative block rounded-lg bg-gray-800 p-3 ring-1 ring-gray-700 transition hover:ring-gray-500"
              >
                {b.mediaInfo && STATUS_LABEL[b.mediaInfo.status] && (
                  <span
                    className={`absolute right-2 top-2 z-10 rounded px-2 py-0.5 text-xs font-semibold text-white ${STATUS_LABEL[b.mediaInfo.status]?.color}`}
                  >
                    {STATUS_LABEL[b.mediaInfo.status]?.text}
                  </span>
                )}
                {b.remoteCover ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={b.remoteCover}
                    alt=""
                    className="mb-2 aspect-[2/3] w-full rounded object-cover"
                  />
                ) : (
                  <div className="mb-2 aspect-[2/3] w-full rounded bg-gray-700" />
                )}
                <div className="truncate text-sm font-medium text-white">
                  {b.title}
                </div>
                {b.authorTitle && (
                  <div className="truncate text-xs text-gray-400">
                    {b.authorTitle}
                  </div>
                )}
                <div className="text-xs text-gray-500">
                  {b.releaseDate?.slice(0, 4) ?? ''}
                  {b.rating ? ` · ★ ${b.rating.toFixed(1)}` : ''}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default BookDiscover;
