import type { BookFilterValues } from '@app/components/BookFilterSlideover';
import BookFilterSlideover, {
  countActiveBookFilters,
  parseBookFilters,
} from '@app/components/BookFilterSlideover';
import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import BookTitleCard from '@app/components/TitleCard/BookTitleCard';
import { BarsArrowDownIcon, FunnelIcon } from '@heroicons/react/24/solid';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import useSWR from 'swr';

interface BookHit {
  title: string;
  foreignBookId: string;
  foreignEditionId?: string;
  authorTitle?: string;
  releaseDate?: string;
  pageCount?: number;
  remoteCover?: string;
  images?: { coverType: string; url: string; remoteUrl?: string }[];
  ratings?: { value?: number; votes?: number };
  rating?: number | null;
  usersCount?: number;
  overview?: string;
  mediaInfo?: { status: number };
}

interface BookSearchProps {
  mediaType: 'audiobook' | 'ebook';
}

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'popularity:desc', label: 'Popularity Descending' },
  { value: 'popularity:asc', label: 'Popularity Ascending' },
  { value: 'trending:month', label: 'Trending: Last Month' },
  { value: 'trending:quarter', label: 'Trending: Last 3 Months' },
  { value: 'trending:year', label: 'Trending: Last Year' },
  { value: 'trending:all', label: 'Trending: All Time' },
  { value: 'release_date:desc', label: 'Release Date Descending' },
  { value: 'release_date:asc', label: 'Release Date Ascending' },
  { value: 'rating:desc', label: 'Rating Descending' },
  { value: 'rating:asc', label: 'Rating Ascending' },
  { value: 'title:asc', label: 'Title (A-Z) Ascending' },
  { value: 'title:desc', label: 'Title (Z-A) Descending' },
];

const titleCase = (s: string) =>
  s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const guessAuthor = (authorTitle: string | undefined, title: string) => {
  if (!authorTitle) return '';
  // If it already looks clean (no comma, no dup of title), return as-is.
  if (!authorTitle.includes(',') && !authorTitle.includes(title)) {
    return authorTitle;
  }
  let s = authorTitle.replace(title, '').trim();
  if (s.endsWith(',')) s = s.slice(0, -1).trim();
  const tokens = s.split(/[, ]+/).filter(Boolean);
  return titleCase(tokens.slice(0, 4).join(' '));
};

const cover = (b: BookHit): string | undefined =>
  b.remoteCover ??
  b.images?.find((i) => i.coverType === 'cover')?.remoteUrl ??
  b.images?.find((i) => i.coverType === 'cover')?.url;

const BookSearch = ({ mediaType }: BookSearchProps) => {
  const router = useRouter();
  const isAudio = mediaType === 'audiobook';
  const baseLabel = isAudio ? 'Audiobooks' : 'Ebooks';
  const apiBase = isAudio ? '/api/v1/audiobook' : '/api/v1/ebook';

  const query = useMemo(
    () =>
      typeof router.query.query === 'string'
        ? decodeURIComponent(router.query.query)
        : '',
    [router.query.query]
  );
  const sortKey =
    (typeof router.query.sortBy === 'string' && router.query.sortBy) ||
    'popularity:desc';

  const filters = useMemo(() => parseBookFilters(router.query), [router.query]);
  const activeFilterCount = countActiveBookFilters(filters);
  const [showFilters, setShowFilters] = useState(false);

  // SWR-cached fetch — second navigations within the session render instantly.
  const fetchUrl = query
    ? `${apiBase}/search?q=${encodeURIComponent(query)}`
    : (() => {
        const [sort, second] = sortKey.split(':');
        const qs = new URLSearchParams({ sort, limit: '36' });
        if (sort === 'trending') {
          qs.set('trendingPeriod', second);
        } else {
          qs.set('dir', second);
        }
        if (filters.releaseFrom) qs.set('releaseFrom', filters.releaseFrom);
        if (filters.releaseTo) qs.set('releaseTo', filters.releaseTo);
        if (filters.pagesMin != null)
          qs.set('pagesMin', String(filters.pagesMin));
        if (filters.pagesMax != null)
          qs.set('pagesMax', String(filters.pagesMax));
        if (filters.ratingMin != null)
          qs.set('ratingMin', String(filters.ratingMin));
        if (filters.ratingMax != null)
          qs.set('ratingMax', String(filters.ratingMax));
        if (filters.usersCountMin != null)
          qs.set('usersCountMin', String(filters.usersCountMin));
        if (filters.tagIds && filters.tagIds.length)
          qs.set('tagIds', filters.tagIds.join(','));
        return `${apiBase}/discover?${qs.toString()}`;
      })();

  const { data, isValidating } = useSWR<{ results: BookHit[] }>(fetchUrl, {
    revalidateOnFocus: false,
    dedupingInterval: 5 * 60 * 1000,
  });

  const hits = data?.results;
  const loading = !data && isValidating;

  const updateSort = (value: string) => {
    router.replace(
      { pathname: router.pathname, query: { ...router.query, sortBy: value } },
      undefined,
      { shallow: true }
    );
  };

  const applyFilters = (next: BookFilterValues) => {
    const newQuery: Record<string, string> = {};
    for (const [k, v] of Object.entries(router.query)) {
      if (
        [
          'releaseFrom',
          'releaseTo',
          'pagesMin',
          'pagesMax',
          'ratingMin',
          'ratingMax',
          'usersCountMin',
          'tagIds',
        ].includes(k)
      ) {
        continue;
      }
      if (typeof v === 'string') newQuery[k] = v;
    }
    if (next.releaseFrom) newQuery.releaseFrom = next.releaseFrom;
    if (next.releaseTo) newQuery.releaseTo = next.releaseTo;
    if (next.pagesMin != null) newQuery.pagesMin = String(next.pagesMin);
    if (next.pagesMax != null) newQuery.pagesMax = String(next.pagesMax);
    if (next.ratingMin != null) newQuery.ratingMin = String(next.ratingMin);
    if (next.ratingMax != null) newQuery.ratingMax = String(next.ratingMax);
    if (next.usersCountMin != null)
      newQuery.usersCountMin = String(next.usersCountMin);
    if (next.tagIds && next.tagIds.length)
      newQuery.tagIds = next.tagIds.join(',');
    router.replace({ pathname: router.pathname, query: newQuery }, undefined, {
      shallow: true,
    });
  };

  return (
    <>
      <PageTitle title={baseLabel} />
      <div className="mb-4 flex flex-col justify-between lg:flex-row lg:items-end">
        <Header>{baseLabel}</Header>
        {!query && (
          <div className="mt-2 flex flex-grow flex-col sm:flex-row lg:flex-grow-0">
            <div className="mb-2 flex flex-grow sm:mb-0 sm:mr-2 lg:flex-grow-0">
              <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
                <BarsArrowDownIcon className="h-6 w-6" />
              </span>
              <select
                id="sortBy"
                name="sortBy"
                className="rounded-r-only"
                value={sortKey}
                onChange={(e) => updateSort(e.target.value)}
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="mb-2 flex flex-grow sm:mb-0 lg:flex-grow-0">
              <Button onClick={() => setShowFilters(true)} className="w-full">
                <FunnelIcon />
                <span>{activeFilterCount} Active Filters</span>
              </Button>
            </div>
          </div>
        )}
      </div>

      <BookFilterSlideover
        show={showFilters}
        onClose={() => setShowFilters(false)}
        values={filters}
        onApply={applyFilters}
        mediaType={mediaType}
      />

      {loading && <LoadingSpinner />}

      {hits && hits.length === 0 && (
        <div className="mt-6 text-sm text-gray-400">
          {query
            ? `No ${baseLabel.toLowerCase()} results for "${query}".`
            : `No ${baseLabel.toLowerCase()} discovery results. Hardcover may be unreachable.`}
        </div>
      )}

      {hits && hits.length > 0 && (
        <ul className="cards-vertical">
          {hits.map((b) => (
            <li key={b.foreignBookId}>
              <BookTitleCard
                foreignBookId={b.foreignBookId}
                mediaType={mediaType}
                image={cover(b)}
                title={b.title}
                author={guessAuthor(b.authorTitle, b.title)}
                year={b.releaseDate?.slice(0, 4)}
                rating={b.rating}
                summary={b.overview ?? undefined}
                status={b.mediaInfo?.status}
                canExpand
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

export default BookSearch;
