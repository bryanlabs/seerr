import TitleCard from '@app/components/TitleCard';
import BookTitleCard from '@app/components/TitleCard/BookTitleCard';
import { Permission, useUser } from '@app/hooks/useUser';
import type { BookDetails } from '@server/models/Book';
import { useInView } from 'react-intersection-observer';
import useSWR from 'swr';

interface Props {
  id: number;
  foreignBookId: number;
  mediaType: 'audiobook' | 'ebook';
  canExpand?: boolean;
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

const BookMediaCard = ({ id, foreignBookId, mediaType, canExpand }: Props) => {
  const { hasPermission } = useUser();
  const { ref, inView } = useInView({ triggerOnce: true });
  const apiBase =
    mediaType === 'audiobook' ? '/api/v1/audiobook' : '/api/v1/ebook';
  const { data, error } = useSWR<BookDetails>(
    inView ? `${apiBase}/${foreignBookId}` : null
  );

  if (!data && !error) {
    return (
      <div ref={ref}>
        <TitleCard.Placeholder canExpand={canExpand} />
      </div>
    );
  }
  if (!data) {
    return hasPermission(Permission.ADMIN) ? (
      <TitleCard.ErrorCard
        id={id}
        tmdbId={foreignBookId}
        type={mediaType === 'audiobook' ? 'tv' : 'movie'}
      />
    ) : null;
  }
  const cover =
    data.remoteCover ??
    data.images?.find((i) => i.coverType === 'cover')?.remoteUrl ??
    data.images?.find((i) => i.coverType === 'cover')?.url;
  return (
    <BookTitleCard
      foreignBookId={String(foreignBookId)}
      mediaType={mediaType}
      image={cover}
      title={data.title}
      author={data.authorName ?? guessAuthor(data.authorTitle, data.title)}
      year={data.releaseDate?.slice(0, 4)}
      summary={data.overview}
      status={data.mediaInfo?.status}
      canExpand={canExpand}
    />
  );
};

export default BookMediaCard;
