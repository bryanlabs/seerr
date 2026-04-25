import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import {
  ArrowDownTrayIcon,
  CheckIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/solid';
import axios from 'axios';
import { useState } from 'react';
import { useToasts } from 'react-toast-notifications';

interface BookshelfBookResult {
  title: string;
  foreignBookId: string;
  foreignEditionId?: string;
  authorTitle?: string;
  releaseDate?: string;
  pageCount?: number;
  remoteCover?: string;
  images?: { coverType: string; url: string; remoteUrl?: string }[];
  ratings?: { value?: number; votes?: number };
  genres?: string[];
}

interface BookSearchProps {
  mediaType: 'audiobook' | 'ebook';
}

const titleCase = (s: string) =>
  s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const guessAuthor = (authorTitle: string | undefined, title: string) => {
  if (!authorTitle) return '';
  // Bookshelf returns authorTitle like "baroness, orczy, emmuska orczy The Scarlet Pimpernel".
  // Strip the trailing book title and the leading commas to leave a usable
  // author string.
  let s = authorTitle.replace(title, '').trim();
  if (s.endsWith(',')) s = s.slice(0, -1).trim();
  const tokens = s.split(/[, ]+/).filter(Boolean);
  return titleCase(tokens.slice(0, 4).join(' '));
};

const BookSearch = ({ mediaType }: BookSearchProps) => {
  const isAudio = mediaType === 'audiobook';
  const baseLabel = isAudio ? 'Audiobooks' : 'Ebooks';
  const apiBase = isAudio ? '/api/v1/audiobook' : '/api/v1/ebook';

  const { addToast } = useToasts();
  const [term, setTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<BookshelfBookResult[] | null>(null);
  const [requested, setRequested] = useState<
    Record<string, 'pending' | 'done'>
  >({});

  const runSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!term.trim()) return;
    setSearching(true);
    try {
      const r = await axios.get<{
        term: string;
        results: BookshelfBookResult[];
      }>(`${apiBase}/search`, { params: { q: term } });
      setResults(r.data.results ?? []);
    } catch {
      addToast(`${baseLabel} search failed`, {
        appearance: 'error',
        autoDismiss: true,
      });
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const requestBook = async (book: BookshelfBookResult) => {
    setRequested((prev) => ({ ...prev, [book.foreignBookId]: 'pending' }));
    try {
      const authorName = guessAuthor(book.authorTitle, book.title);
      await axios.post(`${apiBase}/request`, {
        foreignBookId: book.foreignBookId,
        authorName,
        title: book.title,
      });
      addToast(`Requested: ${book.title}`, {
        appearance: 'success',
        autoDismiss: true,
      });
      setRequested((prev) => ({ ...prev, [book.foreignBookId]: 'done' }));
    } catch (e) {
      const message =
        (e as { response?: { data?: { message?: string } } }).response?.data
          ?.message ?? 'Request failed';
      addToast(message, { appearance: 'error', autoDismiss: true });
      setRequested((prev) => {
        const copy = { ...prev };
        delete copy[book.foreignBookId];
        return copy;
      });
    }
  };

  const cover = (b: BookshelfBookResult): string | undefined =>
    b.remoteCover ??
    b.images?.find((i) => i.coverType === 'cover')?.remoteUrl ??
    b.images?.find((i) => i.coverType === 'cover')?.url;

  return (
    <>
      <PageTitle title={baseLabel} />
      <div className="mb-6 mt-4">
        <h1 className="text-3xl font-bold text-white">{baseLabel}</h1>
        <p className="mt-1 text-sm text-gray-400">
          Search and request {isAudio ? 'audiobooks' : 'ebooks'}. Results come
          from Bookshelf (Hardcover-backed).
        </p>
      </div>
      <form onSubmit={runSearch} className="mb-6 flex gap-2">
        <div className="relative flex-1">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={`Search ${isAudio ? 'audiobooks' : 'ebooks'} by title or author`}
            className="w-full rounded-md border border-gray-600 bg-gray-800 py-2 pl-10 pr-3 text-white placeholder-gray-400 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <Button
          buttonType="primary"
          type="submit"
          disabled={searching || !term.trim()}
        >
          {searching ? 'Searching…' : 'Search'}
        </Button>
      </form>

      {searching && !results && <LoadingSpinner />}

      {results && results.length === 0 && (
        <div className="text-gray-400">No results for "{term}".</div>
      )}

      {results && results.length > 0 && (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {results.map((b) => {
            const status = requested[b.foreignBookId];
            const author = guessAuthor(b.authorTitle, b.title);
            return (
              <li
                key={b.foreignBookId}
                className="flex gap-4 rounded-lg bg-gray-800 p-4 ring-1 ring-gray-700"
              >
                {cover(b) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={cover(b)}
                    alt=""
                    className="h-32 w-20 flex-shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="h-32 w-20 flex-shrink-0 rounded bg-gray-700" />
                )}
                <div className="flex flex-1 flex-col">
                  <div className="font-semibold text-white">{b.title}</div>
                  {author && (
                    <div className="text-sm text-gray-400">{author}</div>
                  )}
                  <div className="mt-1 text-xs text-gray-500">
                    {b.releaseDate?.slice(0, 4)}
                    {b.pageCount ? ` · ${b.pageCount}p` : ''}
                  </div>
                  <div className="mt-auto flex justify-end pt-3">
                    {status === 'done' ? (
                      <Button
                        buttonType="success"
                        disabled
                        className="cursor-default"
                      >
                        <CheckIcon className="mr-1 h-4 w-4" />
                        Requested
                      </Button>
                    ) : status === 'pending' ? (
                      <Button buttonType="primary" disabled>
                        Requesting…
                      </Button>
                    ) : (
                      <Button
                        buttonType="primary"
                        onClick={() => requestBook(b)}
                      >
                        <ArrowDownTrayIcon className="mr-1 h-4 w-4" />
                        Request
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
};

export default BookSearch;
