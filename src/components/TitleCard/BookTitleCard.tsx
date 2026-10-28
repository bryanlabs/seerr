import BookRequestModal from '@app/components/BookRequestModal';
import Button from '@app/components/Common/Button';
import StatusBadgeMini from '@app/components/Common/StatusBadgeMini';
import { useIsTouch } from '@app/hooks/useIsTouch';
import { Transition } from '@headlessui/react';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { MediaStatus } from '@server/constants/media';
import Link from 'next/link';
import { Fragment, useState } from 'react';

interface BookTitleCardProps {
  foreignBookId: string;
  mediaType: 'audiobook' | 'ebook';
  image?: string;
  title: string;
  author?: string;
  year?: string;
  rating?: number | null;
  summary?: string;
  status?: MediaStatus;
  canExpand?: boolean;
}

const BookTitleCard = ({
  foreignBookId,
  mediaType,
  image,
  title,
  author,
  year,
  rating,
  summary,
  status,
  canExpand = false,
}: BookTitleCardProps) => {
  const isTouch = useIsTouch();
  const [showDetail, setShowDetail] = useState(false);
  const [showRequestModal, setShowRequestModal] = useState(false);
  const isAudio = mediaType === 'audiobook';
  const detailHref = `/${isAudio ? 'audiobooks' : 'ebooks'}/${foreignBookId}`;
  const showRequestButton =
    !status || status === MediaStatus.UNKNOWN || status === MediaStatus.DELETED;

  return (
    <div
      className={canExpand ? 'w-full' : 'w-36 sm:w-36 md:w-44'}
      data-testid="book-title-card"
    >
      <BookRequestModal
        show={showRequestModal}
        mediaType={mediaType}
        foreignBookId={foreignBookId}
        title={title}
        authorName={author}
        cover={image}
        onClose={() => setShowRequestModal(false)}
        onComplete={() => setShowRequestModal(false)}
      />
      <div
        className={`relative transform-gpu cursor-default overflow-hidden rounded-xl bg-gray-800 bg-cover outline-none ring-1 transition duration-300 ${
          showDetail
            ? 'scale-105 shadow-lg ring-gray-500'
            : 'scale-100 shadow ring-gray-700'
        }`}
        style={{ paddingBottom: '150%' }}
        onMouseEnter={() => {
          if (!isTouch) setShowDetail(true);
        }}
        onMouseLeave={() => setShowDetail(false)}
        onClick={() => setShowDetail(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setShowDetail(true);
        }}
        role="link"
        tabIndex={0}
      >
        <div className="absolute inset-0 h-full w-full overflow-hidden">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 h-full w-full bg-gray-700" />
          )}

          <div className="absolute left-0 right-0 flex items-center justify-between p-2">
            <div
              className={`pointer-events-none z-40 self-start rounded-full border shadow-md ${
                isAudio
                  ? 'border-amber-500 bg-amber-600/80'
                  : 'border-emerald-500 bg-emerald-600/80'
              }`}
            >
              <div className="flex h-4 items-center px-2 py-2 text-center text-xs font-medium uppercase tracking-wider text-white sm:h-5">
                {isAudio ? 'Audiobook' : 'Ebook'}
              </div>
            </div>
            {status && status !== MediaStatus.UNKNOWN && (
              <div className="pointer-events-none z-40 flex">
                <StatusBadgeMini status={status} shrink />
              </div>
            )}
          </div>

          <Transition
            as={Fragment}
            show={!image || showDetail || showRequestModal}
            enter="transition-opacity"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="transition-opacity"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="absolute inset-0 overflow-hidden rounded-xl">
              <Link
                href={detailHref}
                className="absolute inset-0 h-full w-full cursor-pointer overflow-hidden text-left"
                style={{
                  background:
                    'linear-gradient(180deg, rgba(45, 55, 72, 0.4) 0%, rgba(45, 55, 72, 0.95) 100%)',
                }}
              >
                <div className="flex h-full w-full items-end">
                  <div
                    className={`px-2 text-white ${showRequestButton ? 'pb-11' : 'pb-2'}`}
                  >
                    {year && <div className="text-sm font-medium">{year}</div>}
                    <h1
                      className="whitespace-normal text-xl font-bold leading-tight"
                      style={{
                        WebkitLineClamp: 3,
                        display: '-webkit-box',
                        overflow: 'hidden',
                        WebkitBoxOrient: 'vertical',
                        wordBreak: 'break-word',
                      }}
                      data-testid="book-title-card-title"
                    >
                      {title}
                    </h1>
                    {author && (
                      <div className="mt-0.5 text-xs text-gray-200">
                        {author}
                        {rating ? ` · ★ ${rating.toFixed(1)}` : ''}
                      </div>
                    )}
                    {summary && (
                      <div
                        className="mt-1 whitespace-normal text-xs"
                        style={{
                          WebkitLineClamp: showRequestButton ? 3 : 5,
                          display: '-webkit-box',
                          overflow: 'hidden',
                          WebkitBoxOrient: 'vertical',
                          wordBreak: 'break-word',
                        }}
                      >
                        {summary}
                      </div>
                    )}
                  </div>
                </div>
              </Link>
              {showRequestButton && (
                <div className="absolute bottom-0 left-0 right-0 flex justify-between px-2 py-2">
                  <Button
                    buttonType="primary"
                    buttonSize="sm"
                    onClick={(e) => {
                      e.preventDefault();
                      setShowRequestModal(true);
                    }}
                    className="h-7 w-full"
                  >
                    <ArrowDownTrayIcon />
                    <span>Request</span>
                  </Button>
                </div>
              )}
            </div>
          </Transition>
        </div>
      </div>
    </div>
  );
};

export default BookTitleCard;
