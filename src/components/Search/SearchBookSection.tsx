import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import axios from 'axios';
import Link from 'next/link';
import { useEffect, useState } from 'react';

interface BookHit {
  title: string;
  foreignBookId: string;
  authorTitle?: string;
  releaseDate?: string;
  remoteCover?: string;
  images?: { coverType: string; url: string; remoteUrl?: string }[];
  mediaInfo?: { status: number };
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

interface Props {
  query: string;
  mediaType: 'audiobook' | 'ebook';
}

const titleCase = (s: string) =>
  s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const guessAuthor = (authorTitle: string | undefined, title: string) => {
  if (!authorTitle) return '';
  let s = authorTitle.replace(title, '').trim();
  if (s.endsWith(',')) s = s.slice(0, -1).trim();
  const tokens = s.split(/[, ]+/).filter(Boolean);
  return titleCase(tokens.slice(0, 4).join(' '));
};

const cover = (b: BookHit): string | undefined =>
  b.remoteCover ??
  b.images?.find((i) => i.coverType === 'cover')?.remoteUrl ??
  b.images?.find((i) => i.coverType === 'cover')?.url;

const SearchBookSection = ({ query, mediaType }: Props) => {
  const isAudio = mediaType === 'audiobook';
  const baseLabel = isAudio ? 'Audiobooks' : 'Ebooks';
  const apiBase = isAudio ? '/api/v1/audiobook' : '/api/v1/ebook';
  const [hits, setHits] = useState<BookHit[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!query) {
      setHits(null);
      return;
    }
    setLoading(true);
    axios
      .get<{ results: BookHit[] }>(`${apiBase}/search`, {
        params: { q: query },
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
  }, [query, apiBase]);

  if (!query) return null;
  if (loading && !hits) {
    return (
      <div className="my-6">
        <h2 className="mb-3 text-lg font-semibold text-white">{baseLabel}</h2>
        <LoadingSpinner />
      </div>
    );
  }
  if (!hits || hits.length === 0) {
    return (
      <div className="my-6">
        <h2 className="mb-3 text-lg font-semibold text-white">{baseLabel}</h2>
        <div className="text-sm text-gray-400">
          No {isAudio ? 'audiobook' : 'ebook'} results for "{query}".
        </div>
      </div>
    );
  }

  const top = hits.slice(0, 12);

  return (
    <div className="my-6">
      <h2 className="mb-3 text-lg font-semibold text-white">{baseLabel}</h2>
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
        {top.map((b) => {
          const author = guessAuthor(b.authorTitle, b.title);
          const detailHref = `/${isAudio ? 'audiobooks' : 'ebooks'}/${b.foreignBookId}`;
          return (
            <li key={b.foreignBookId}>
              <Link
                href={detailHref}
                className="relative block rounded-lg bg-gray-800 p-3 ring-1 ring-gray-700 transition hover:ring-gray-500"
              >
                {b.mediaInfo && STATUS_LABEL[b.mediaInfo.status] && (
                  <span
                    className={`absolute right-2 top-2 z-10 rounded px-2 py-0.5 text-xs font-semibold text-white ${STATUS_LABEL[b.mediaInfo.status]?.color}`}
                  >
                    {STATUS_LABEL[b.mediaInfo.status]?.text}
                  </span>
                )}
                {cover(b) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={cover(b)}
                    alt=""
                    className="mb-2 aspect-[2/3] w-full rounded object-cover"
                  />
                ) : (
                  <div className="mb-2 aspect-[2/3] w-full rounded bg-gray-700" />
                )}
                <div className="truncate text-sm font-medium text-white">
                  {b.title}
                </div>
                {author && (
                  <div className="truncate text-xs text-gray-400">{author}</div>
                )}
                {b.releaseDate && (
                  <div className="text-xs text-gray-500">
                    {b.releaseDate.slice(0, 4)}
                  </div>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default SearchBookSection;
