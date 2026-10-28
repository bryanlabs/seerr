import Slider from '@app/components/Slider';
import BookTitleCard from '@app/components/TitleCard/BookTitleCard';
import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import type { MediaStatus } from '@server/constants/media';
import Link from 'next/link';
import useSWR from 'swr';

interface BookSliderItem {
  title: string;
  foreignBookId: string;
  authorTitle?: string;
  releaseDate?: string;
  remoteCover?: string;
  images?: { coverType: string; url: string; remoteUrl?: string }[];
  rating?: number | null;
  overview?: string;
  mediaInfo?: { status: MediaStatus };
}

interface BookSliderProps {
  sliderKey: string;
  title: string;
  mediaType: 'audiobook' | 'ebook';
  sort: 'popularity' | 'trending' | 'release_date' | 'rating';
  dir?: 'asc' | 'desc';
  trendingPeriod?: 'month' | 'quarter' | 'year' | 'all';
}

const titleCase = (s: string) =>
  s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const guessAuthor = (authorTitle: string | undefined, title: string) => {
  if (!authorTitle) return '';
  if (!authorTitle.includes(',') && !authorTitle.includes(title)) {
    return authorTitle;
  }
  let s = authorTitle.replace(title, '').trim();
  if (s.endsWith(',')) s = s.slice(0, -1).trim();
  const tokens = s.split(/[, ]+/).filter(Boolean);
  return titleCase(tokens.slice(0, 4).join(' '));
};

const cover = (b: BookSliderItem): string | undefined =>
  b.remoteCover ??
  b.images?.find((i) => i.coverType === 'cover')?.remoteUrl ??
  b.images?.find((i) => i.coverType === 'cover')?.url;

const BookSliderPlaceholder = () => (
  <div className="w-36 animate-pulse rounded-xl bg-gray-800 sm:w-36 md:w-44">
    <div className="w-full" style={{ paddingBottom: '150%' }} />
  </div>
);

const BookSlider = ({
  sliderKey,
  title,
  mediaType,
  sort,
  dir = 'desc',
  trendingPeriod = 'month',
}: BookSliderProps) => {
  const isAudio = mediaType === 'audiobook';
  const apiBase = isAudio ? '/api/v1/audiobook' : '/api/v1/ebook';
  const pageBase = isAudio ? '/audiobooks' : '/ebooks';
  const params = new URLSearchParams({
    sort,
    limit: '20',
    ...(sort === 'trending' ? { trendingPeriod } : { dir }),
  });
  const { data } = useSWR<{ results: BookSliderItem[] }>(
    `${apiBase}/discover?${params.toString()}`
  );
  const results = data?.results ?? [];

  if (data && results.length === 0) {
    return null;
  }

  return (
    <>
      <div className="slider-header">
        <Link
          href={`${pageBase}?sortBy=${
            sort === 'trending'
              ? `trending:${trendingPeriod}`
              : `${sort}:${dir}`
          }`}
          className="slider-title"
        >
          <span>{title}</span>
          <ArrowRightCircleIcon />
        </Link>
      </div>
      <Slider
        sliderKey={sliderKey}
        isLoading={!data}
        items={results.map((b) => (
          <BookTitleCard
            key={`${mediaType}-${b.foreignBookId}`}
            foreignBookId={b.foreignBookId}
            mediaType={mediaType}
            image={cover(b)}
            title={b.title}
            author={guessAuthor(b.authorTitle, b.title)}
            year={b.releaseDate?.slice(0, 4)}
            rating={b.rating}
            summary={b.overview ?? undefined}
            status={b.mediaInfo?.status}
          />
        ))}
        placeholder={<BookSliderPlaceholder />}
      />
    </>
  );
};

export default BookSlider;
