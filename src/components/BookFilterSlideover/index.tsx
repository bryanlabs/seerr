import Button from '@app/components/Common/Button';
import SlideOver from '@app/components/Common/SlideOver';
import type { ParsedUrlQuery } from 'querystring';
import { useState } from 'react';
import type { MultiValue } from 'react-select';
import Select from 'react-select';
import useSWR from 'swr';

export interface BookFilterValues {
  releaseFrom?: string;
  releaseTo?: string;
  pagesMin?: number;
  pagesMax?: number;
  ratingMin?: number;
  ratingMax?: number;
  usersCountMin?: number;
  /** Tag IDs (genre + mood IDs combined into one array for the API) */
  tagIds?: number[];
}

interface TagOption {
  id: number;
  tag: string;
  count: number;
}

export const parseBookFilters = (q: ParsedUrlQuery): BookFilterValues => {
  const num = (k: string) => {
    const v = q[k];
    if (typeof v !== 'string' || !v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (k: string) =>
    typeof q[k] === 'string' && q[k] ? (q[k] as string) : undefined;
  const ids = str('tagIds');
  return {
    releaseFrom: str('releaseFrom'),
    releaseTo: str('releaseTo'),
    pagesMin: num('pagesMin'),
    pagesMax: num('pagesMax'),
    ratingMin: num('ratingMin'),
    ratingMax: num('ratingMax'),
    usersCountMin: num('usersCountMin'),
    tagIds: ids
      ? ids
          .split(',')
          .map((s) => Number(s))
          .filter((n) => Number.isFinite(n))
      : undefined,
  };
};

export const countActiveBookFilters = (f: BookFilterValues): number => {
  let n = 0;
  if (f.releaseFrom) n++;
  if (f.releaseTo) n++;
  if (f.pagesMin) n++;
  if (f.pagesMax) n++;
  if (f.ratingMin) n++;
  if (f.ratingMax && f.ratingMax < 5) n++;
  if (f.usersCountMin) n++;
  if (f.tagIds && f.tagIds.length > 0) n += f.tagIds.length;
  return n;
};

interface Props {
  show: boolean;
  onClose: () => void;
  values: BookFilterValues;
  onApply: (next: BookFilterValues) => void;
  mediaType: 'audiobook' | 'ebook';
}

interface SelectItem {
  label: string;
  value: number;
}

const titleCase = (s: string): string =>
  s.replace(/(^|\s)\S/g, (c) => c.toUpperCase());

const TagMultiSelect = ({
  options,
  selectedIds,
  onChange,
  placeholder,
}: {
  options: TagOption[] | undefined;
  selectedIds: Set<number>;
  onChange: (ids: number[]) => void;
  placeholder: string;
}) => {
  const items: SelectItem[] = (options ?? []).map((o) => ({
    label: `${titleCase(o.tag)} (${o.count.toLocaleString()})`,
    value: o.id,
  }));
  const value = items.filter((i) => selectedIds.has(i.value));
  return (
    <Select
      className="react-select-container"
      classNamePrefix="react-select"
      isMulti
      isClearable
      isLoading={!options}
      options={items}
      value={value}
      placeholder={placeholder}
      onChange={(v: MultiValue<SelectItem>) => onChange(v.map((x) => x.value))}
    />
  );
};

const BookFilterSlideover = ({
  show,
  onClose,
  values,
  onApply,
  mediaType,
}: Props) => {
  const [draft, setDraft] = useState<BookFilterValues>(values);
  const update = <K extends keyof BookFilterValues>(
    k: K,
    v: BookFilterValues[K]
  ) => setDraft((d) => ({ ...d, [k]: v }));

  const apiBase =
    mediaType === 'audiobook' ? '/api/v1/audiobook' : '/api/v1/ebook';
  const { data: genreData } = useSWR<{ results: TagOption[] }>(
    show ? `${apiBase}/tags?category=1&limit=200` : null,
    { revalidateOnFocus: false, dedupingInterval: 24 * 60 * 60 * 1000 }
  );
  const { data: moodData } = useSWR<{ results: TagOption[] }>(
    show ? `${apiBase}/tags?category=4&limit=200` : null,
    { revalidateOnFocus: false, dedupingInterval: 24 * 60 * 60 * 1000 }
  );
  const { data: tagData } = useSWR<{ results: TagOption[] }>(
    show ? `${apiBase}/tags?category=2&limit=200` : null,
    { revalidateOnFocus: false, dedupingInterval: 24 * 60 * 60 * 1000 }
  );

  // The three categories share one tagIds list. Derive per-category selections
  // from the global set so each Select shows only its own picks.
  const allSelected = new Set(draft.tagIds ?? []);
  const genreIds = new Set((genreData?.results ?? []).map((g) => g.id));
  const moodIds = new Set((moodData?.results ?? []).map((m) => m.id));
  const tagCatIds = new Set((tagData?.results ?? []).map((t) => t.id));
  const selectedGenres = new Set(
    Array.from(allSelected).filter((id) => genreIds.has(id))
  );
  const selectedMoods = new Set(
    Array.from(allSelected).filter((id) => moodIds.has(id))
  );
  const selectedTags = new Set(
    Array.from(allSelected).filter((id) => tagCatIds.has(id))
  );

  const updateCategory = (categoryIds: number[], otherIds: Set<number>) => {
    const merged = new Set([...categoryIds, ...otherIds]);
    update('tagIds', merged.size > 0 ? Array.from(merged) : undefined);
  };

  const apply = () => {
    onApply(draft);
    onClose();
  };
  const clear = () => {
    setDraft({});
    onApply({});
    onClose();
  };

  return (
    <SlideOver
      show={show}
      title={`${countActiveBookFilters(draft)} Active Filters`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-6 px-2 pb-6">
        <div>
          <h4 className="mb-2 text-sm font-semibold text-white">Genres</h4>
          <TagMultiSelect
            options={genreData?.results}
            selectedIds={selectedGenres}
            onChange={(ids) => {
              const others = new Set(allSelected);
              for (const g of selectedGenres) others.delete(g);
              updateCategory(ids, others);
            }}
            placeholder="Select genres…"
          />
        </div>
        <div>
          <h4 className="mb-2 text-sm font-semibold text-white">Moods</h4>
          <TagMultiSelect
            options={moodData?.results}
            selectedIds={selectedMoods}
            onChange={(ids) => {
              const others = new Set(allSelected);
              for (const m of selectedMoods) others.delete(m);
              updateCategory(ids, others);
            }}
            placeholder="Select moods…"
          />
        </div>
        <div>
          <h4 className="mb-2 text-sm font-semibold text-white">Tags</h4>
          <TagMultiSelect
            options={tagData?.results}
            selectedIds={selectedTags}
            onChange={(ids) => {
              const others = new Set(allSelected);
              for (const t of selectedTags) others.delete(t);
              updateCategory(ids, others);
            }}
            placeholder="Select tags…"
          />
        </div>
        <div>
          <h4 className="mb-2 text-sm font-semibold text-white">
            Release Date
          </h4>
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="mb-1 block text-xs text-gray-400">From</span>
              <input
                type="date"
                value={draft.releaseFrom ?? ''}
                onChange={(e) =>
                  update('releaseFrom', e.target.value || undefined)
                }
                className="w-full rounded-md border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-white"
              />
            </label>
            <label className="flex-1">
              <span className="mb-1 block text-xs text-gray-400">To</span>
              <input
                type="date"
                value={draft.releaseTo ?? ''}
                onChange={(e) =>
                  update('releaseTo', e.target.value || undefined)
                }
                className="w-full rounded-md border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-white"
              />
            </label>
          </div>
        </div>

        <div>
          <h4 className="mb-2 text-sm font-semibold text-white">Pages</h4>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={5000}
              placeholder="Min"
              value={draft.pagesMin ?? ''}
              onChange={(e) =>
                update(
                  'pagesMin',
                  e.target.value ? Number(e.target.value) : undefined
                )
              }
              className="w-24 rounded-md border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-white"
            />
            <span className="text-gray-400">to</span>
            <input
              type="number"
              min={0}
              max={5000}
              placeholder="Max"
              value={draft.pagesMax ?? ''}
              onChange={(e) =>
                update(
                  'pagesMax',
                  e.target.value ? Number(e.target.value) : undefined
                )
              }
              className="w-24 rounded-md border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-white"
            />
            <span className="text-xs text-gray-500">pages</span>
          </div>
        </div>

        <div>
          <h4 className="mb-2 text-sm font-semibold text-white">
            Hardcover Rating
          </h4>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={5}
              step={0.1}
              placeholder="Min"
              value={draft.ratingMin ?? ''}
              onChange={(e) =>
                update(
                  'ratingMin',
                  e.target.value ? Number(e.target.value) : undefined
                )
              }
              className="w-20 rounded-md border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-white"
            />
            <span className="text-gray-400">to</span>
            <input
              type="number"
              min={0}
              max={5}
              step={0.1}
              placeholder="Max"
              value={draft.ratingMax ?? ''}
              onChange={(e) =>
                update(
                  'ratingMax',
                  e.target.value ? Number(e.target.value) : undefined
                )
              }
              className="w-20 rounded-md border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-white"
            />
            <span className="text-xs text-gray-500">★ (0-5)</span>
          </div>
        </div>

        <div>
          <h4 className="mb-2 text-sm font-semibold text-white">
            Minimum Hardcover Readers
          </h4>
          <input
            type="number"
            min={0}
            max={100000}
            placeholder="e.g. 500"
            value={draft.usersCountMin ?? ''}
            onChange={(e) =>
              update(
                'usersCountMin',
                e.target.value ? Number(e.target.value) : undefined
              )
            }
            className="w-32 rounded-md border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-white"
          />
          <div className="mt-1 text-xs text-gray-500">
            Only show books with at least this many Hardcover readers
            (popularity floor).
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <Button buttonType="primary" onClick={apply}>
            Apply
          </Button>
          <Button buttonType="default" onClick={clear}>
            Clear all
          </Button>
        </div>
      </div>
    </SlideOver>
  );
};

export default BookFilterSlideover;
