import cacheManager from '@server/lib/cache';
import logger from '@server/logger';
import axios from 'axios';

export interface HardcoverBook {
  id: number;
  title: string;
  slug: string;
  release_date: string | null;
  users_count: number;
  rating: number | null;
  pages: number | null;
  description: string | null;
  image: { url: string } | null;
  contributions: { author: { name: string } | null }[];
}

interface HardcoverSearchDocument {
  id: string | number;
  title?: string | null;
  slug?: string | null;
  release_date?: string | null;
  users_count?: number | null;
  rating?: number | null;
  pages?: number | null;
  description?: string | null;
  image?: { url?: string | null } | null;
  contributions?:
    | { author?: { id?: number | null; name?: string | null } | null }[]
    | null;
  author_names?: string[] | null;
  alternative_titles?: string[] | null;
  series_names?: string[] | null;
  has_audiobook?: boolean | null;
  has_ebook?: boolean | null;
}

interface HardcoverSearchHit {
  document?: HardcoverSearchDocument | null;
}

interface HardcoverSearchOutput {
  ids?: number[];
  error?: string | null;
  results?: {
    hits?: HardcoverSearchHit[];
  } | null;
}

type BookSearchMediaType = 'audiobook' | 'ebook';

type SortField =
  | 'popularity'
  | 'title'
  | 'release_date'
  | 'rating'
  | 'users_count'
  | 'trending';
type SortDir = 'asc' | 'desc';
export type TrendingPeriod = 'month' | 'quarter' | 'year' | 'all';

interface DiscoverParams {
  sort?: SortField;
  dir?: SortDir;
  limit?: number;
  offset?: number;
  releaseFrom?: string;
  releaseTo?: string;
  pagesMin?: number;
  pagesMax?: number;
  ratingMin?: number;
  ratingMax?: number;
  usersCountMin?: number;
  /** Tag IDs (any-match) the book must have at least one of */
  tagIds?: number[];
  /** Trending window — only used when sort='trending' */
  trendingPeriod?: TrendingPeriod;
}

const ORDER_BY: Record<SortField, string> = {
  popularity: 'users_count',
  users_count: 'users_count',
  title: 'title',
  release_date: 'release_date',
  rating: 'rating',
  trending: 'users_count', // unused; trending is dispatched to a different code path
};

const normalizeSearchText = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const compactSearchText = (value: string): string =>
  normalizeSearchText(value).replace(/\s+/g, '');

const buildBookSearchQueries = (term: string): string[] => {
  const cleaned = normalizeSearchText(term);
  if (!cleaned) return [];

  const out = [cleaned];
  const compact = compactSearchText(term);
  const isSingleToken = cleaned === compact;

  if (isSingleToken && compact.length >= 7 && compact.length <= 24) {
    for (let i = 3; i <= compact.length - 3; i += 1) {
      out.push(`${compact.slice(0, i)} ${compact.slice(i)}`);
    }
  }

  return [...new Set(out)];
};

const searchDocumentToBook = (
  doc: HardcoverSearchDocument
): HardcoverBook | undefined => {
  const id = Number(doc.id);
  if (!Number.isFinite(id) || !doc.title) return undefined;

  const authorNames = [
    ...(doc.contributions ?? [])
      .map((c) => c.author?.name)
      .filter((name): name is string => !!name),
    ...(doc.author_names ?? []),
  ];
  const seenAuthors = new Set<string>();
  const contributions = authorNames
    .filter((name) => {
      const key = name.toLowerCase();
      if (seenAuthors.has(key)) return false;
      seenAuthors.add(key);
      return true;
    })
    .map((name) => ({ author: { name } }));

  return {
    id,
    title: doc.title,
    slug: doc.slug ?? String(id),
    release_date: doc.release_date ?? null,
    users_count: doc.users_count ?? 0,
    rating: doc.rating ?? null,
    pages: doc.pages ?? null,
    description: doc.description ?? null,
    image: doc.image?.url ? { url: doc.image.url } : null,
    contributions,
  };
};

const matchingAuthorIds = (
  docs: HardcoverSearchDocument[],
  term: string
): number[] => {
  const query = normalizeSearchText(term);
  const compactQuery = compactSearchText(term);
  const counts = new Map<number, number>();

  for (const doc of docs) {
    for (const contribution of doc.contributions ?? []) {
      const author = contribution.author;
      const id = Number(author?.id);
      if (!Number.isFinite(id) || !author?.name) continue;

      const normalized = normalizeSearchText(author.name);
      const compact = compactSearchText(author.name);
      if (
        normalized === query ||
        compact === compactQuery ||
        normalized.includes(query) ||
        compact.includes(compactQuery)
      ) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .slice(0, 3);
};

const hardcoverBookToSearchDocument = (
  book: HardcoverBook
): HardcoverSearchDocument => ({
  id: book.id,
  title: book.title,
  slug: book.slug,
  release_date: book.release_date,
  users_count: book.users_count,
  rating: book.rating,
  pages: book.pages,
  description: book.description,
  image: book.image,
  contributions: book.contributions.map((c) => ({
    author: c.author ? { name: c.author.name } : null,
  })),
  author_names: book.contributions
    .map((c) => c.author?.name)
    .filter((name): name is string => !!name),
});

const scoreSearchDocument = (
  doc: HardcoverSearchDocument,
  term: string,
  mediaType?: BookSearchMediaType
): number => {
  const query = normalizeSearchText(term);
  const compactQuery = compactSearchText(term);
  const title = normalizeSearchText(doc.title ?? '');
  const compactTitle = compactSearchText(doc.title ?? '');
  const slug = normalizeSearchText((doc.slug ?? '').replace(/-/g, ' '));
  const authorNames = [
    ...(doc.author_names ?? []),
    ...(doc.contributions ?? [])
      .map((c) => c.author?.name)
      .filter((name): name is string => !!name),
  ].filter((name, index, names) => {
    const key = normalizeSearchText(name);
    return names.findIndex((n) => normalizeSearchText(n) === key) === index;
  });
  const alternatives = doc.alternative_titles ?? [];
  const seriesNames = doc.series_names ?? [];
  const popularity = Math.min(doc.users_count ?? 0, 10000);
  let authorMatched = false;

  let score = Math.log10(popularity + 1) * 120;

  for (const author of authorNames) {
    const normalized = normalizeSearchText(author);
    const compact = compactSearchText(author);
    if (normalized === query || compact === compactQuery) {
      score += 4200;
      authorMatched = true;
    } else if (normalized.startsWith(query)) {
      score += 2600;
      authorMatched = true;
    } else if (normalized.includes(query) || compact.includes(compactQuery)) {
      score += 3600;
      authorMatched = true;
    }
  }

  if (title === query) score += 5000;
  else if (!authorMatched && title.startsWith(query)) score += 2600;
  else if (!authorMatched && title.includes(query)) score += 1600;

  if (compactTitle === compactQuery) score += 5200;
  else if (!authorMatched && compactTitle.startsWith(compactQuery))
    score += 1800;
  else if (!authorMatched && compactTitle.includes(compactQuery)) score += 900;

  if (slug === query) score += 1000;
  else if (!authorMatched && slug.includes(query)) score += 500;

  for (const alt of alternatives) {
    const normalized = normalizeSearchText(alt);
    const compact = compactSearchText(alt);
    if (normalized === query || compact === compactQuery) score += 1800;
    else if (
      !authorMatched &&
      (normalized.includes(query) || compact.includes(compactQuery))
    ) {
      score += 600;
    }
  }

  for (const series of seriesNames) {
    const normalized = normalizeSearchText(series);
    if (normalized === query) score += 800;
    else if (normalized.includes(query)) score += 400;
  }

  if (mediaType === 'audiobook' && doc.has_audiobook) score += 250;
  if (mediaType === 'ebook' && doc.has_ebook) score += 250;

  const queryWantsSummary =
    query.includes('summary') ||
    query.includes('study guide') ||
    query.includes('sampler') ||
    query.includes('book guide');
  if (!queryWantsSummary) {
    const noisyTitle = title;
    if (
      noisyTitle.includes('summary') ||
      noisyTitle.includes('study guide') ||
      noisyTitle.includes('sampler') ||
      noisyTitle.includes('book guide')
    ) {
      score -= 1400;
    }
  }

  return score;
};

class HardcoverAPI {
  private endpoint = 'https://api.hardcover.app/v1/graphql';
  private token: string;

  constructor(token: string) {
    this.token = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  }

  /**
   * Map tag IDs to their category. Cached because the tag→category mapping is
   * stable. Returns Map<categoryId, tagIds[]> for the input list.
   */
  private async groupTagsByCategory(
    tagIds: number[]
  ): Promise<Map<number, number[]>> {
    if (!tagIds.length) return new Map();
    const cache = cacheManager.getCache('hardcover').data;
    const out = new Map<number, number[]>();
    const missing: number[] = [];
    for (const id of tagIds) {
      const cached = cache.get<number>(`tagcat:${id}`);
      if (cached != null) {
        if (!out.has(cached)) out.set(cached, []);
        out.get(cached)!.push(id);
      } else {
        missing.push(id);
      }
    }
    if (missing.length === 0) return out;
    try {
      const r = await axios.post(
        this.endpoint,
        {
          query: `query Cats($ids: [bigint!]!) { tags(where: {id: {_in: $ids}}) { id tag_category_id } }`,
          variables: { ids: missing },
        },
        {
          headers: {
            Authorization: this.token,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        }
      );
      const rows = (r.data?.data?.tags ?? []) as {
        id: number;
        tag_category_id: number;
      }[];
      for (const row of rows) {
        cache.set(`tagcat:${row.id}`, row.tag_category_id, 86400);
        if (!out.has(row.tag_category_id)) out.set(row.tag_category_id, []);
        out.get(row.tag_category_id)!.push(row.id);
      }
    } catch (e) {
      logger.warn('Hardcover groupTagsByCategory failed', {
        label: 'Hardcover',
        message: (e as Error).message,
      });
    }
    return out;
  }

  public async getTopTags(
    categoryId: number,
    limit = 40
  ): Promise<{ id: number; tag: string; count: number }[]> {
    const cache = cacheManager.getCache('hardcover').data;
    const cacheKey = `tags:cat=${categoryId}:limit=${limit}`;
    const cached =
      cache.get<{ id: number; tag: string; count: number }[]>(cacheKey);
    if (cached) return cached;
    const query = `
      query Tags($cat: Int!, $limit: Int!) {
        tags(where: {tag_category_id: {_eq: $cat}}, order_by: {count: desc}, limit: $limit) {
          id tag count
        }
      }
    `;
    try {
      const r = await axios.post(
        this.endpoint,
        { query, variables: { cat: categoryId, limit } },
        {
          headers: {
            Authorization: this.token,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );
      const tags = (r.data?.data?.tags ?? []) as {
        id: number;
        tag: string;
        count: number;
      }[];
      // Cache for 24h — tag list barely changes.
      cache.set(cacheKey, tags, 86400);
      return tags;
    } catch (e) {
      logger.error('Hardcover getTopTags failed', {
        label: 'Hardcover',
        categoryId,
        message: (e as Error).message,
      });
      return [];
    }
  }

  public async getTrending(
    period: TrendingPeriod,
    limit: number
  ): Promise<HardcoverBook[]> {
    const cache = cacheManager.getCache('hardcover').data;
    const cacheKey = `trending:${period}:${limit}`;
    const cached = cache.get<HardcoverBook[]>(cacheKey);
    if (cached) return cached;
    const today = new Date();
    const fromDate = new Date(today);
    if (period === 'month') fromDate.setMonth(today.getMonth() - 1);
    else if (period === 'quarter') fromDate.setMonth(today.getMonth() - 3);
    else if (period === 'year') fromDate.setFullYear(today.getFullYear() - 1);
    else fromDate.setFullYear(today.getFullYear() - 5);
    const from = fromDate.toISOString().slice(0, 10);
    const to = today.toISOString().slice(0, 10);
    const trendingQuery = `
      query Trending($from: date!, $to: date!, $limit: Int!) {
        books_trending(from: $from, to: $to, limit: $limit, offset: 0) {
          ids
          error
        }
      }
    `;
    try {
      const t = await axios.post(
        this.endpoint,
        { query: trendingQuery, variables: { from, to, limit } },
        {
          headers: {
            Authorization: this.token,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );
      const ids = (t.data?.data?.books_trending?.ids ?? []) as number[];
      if (!ids.length) {
        cache.set(cacheKey, [], 1800);
        return [];
      }
      const detailQuery = `
        query TrendingDetails($ids: [Int!]!) {
          books(where: {id: {_in: $ids}}) {
            id title slug release_date users_count rating pages description
            image { url }
            contributions(limit: 3) { author { name } }
          }
        }
      `;
      const d = await axios.post(
        this.endpoint,
        { query: detailQuery, variables: { ids } },
        {
          headers: {
            Authorization: this.token,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );
      const books = (d.data?.data?.books ?? []) as HardcoverBook[];
      // Re-order to match the trending ranking.
      const sorted = ids
        .map((id) => books.find((b) => b.id === id))
        .filter((b): b is HardcoverBook => !!b);
      cache.set(cacheKey, sorted, 1800);
      return sorted;
    } catch (e) {
      logger.error('Hardcover getTrending failed', {
        label: 'Hardcover',
        period,
        message: (e as Error).message,
      });
      return [];
    }
  }

  public async discover(params: DiscoverParams = {}): Promise<HardcoverBook[]> {
    const {
      sort = 'popularity',
      dir = 'desc',
      limit = 36,
      offset = 0,
      releaseFrom,
      releaseTo,
      pagesMin,
      pagesMax,
      ratingMin,
      ratingMax,
      usersCountMin,
      tagIds,
      trendingPeriod,
    } = params;

    if (sort === 'trending') {
      return this.getTrending(trendingPeriod ?? 'month', limit);
    }
    const orderField = ORDER_BY[sort] ?? 'users_count';
    const filterParts = [
      releaseFrom ?? '',
      releaseTo ?? '',
      pagesMin ?? '',
      pagesMax ?? '',
      ratingMin ?? '',
      ratingMax ?? '',
      usersCountMin ?? '',
      (tagIds ?? [])
        .slice()
        .sort((a, b) => a - b)
        .join(','),
    ].join(':');
    const cacheKey = `discover:${orderField}:${dir}:${limit}:${offset}:${filterParts}`;
    const cache = cacheManager.getCache('hardcover').data;
    const cached = cache.get<HardcoverBook[]>(cacheKey);
    if (cached) return cached;

    // Build the where clause: sort-driven defaults plus user-supplied filters.
    const today = new Date().toISOString().slice(0, 10);
    const conditions: string[] = [];

    // users_count floor — pulled from filter if supplied, else sort-default.
    // When a tag filter is active, drop the floor low so small comics / niche
    // genre books still make the candidate pool. The post-sort by tag count
    // surfaces the best matches regardless of how popular the book is overall.
    let usersFloor = usersCountMin ?? 50;
    if (orderField === 'release_date' && usersCountMin == null) {
      usersFloor = 10;
    } else if (orderField === 'rating' && usersCountMin == null) {
      usersFloor = 200;
    } else if (tagIds && tagIds.length > 0 && usersCountMin == null) {
      usersFloor = 10;
    }
    conditions.push(`users_count: { _gt: ${usersFloor} }`);

    // release_date: sort-default + user range
    const releaseConds: string[] = [];
    if (orderField === 'release_date') {
      releaseConds.push(`_is_null: false`);
      if (dir === 'desc' && !releaseTo) releaseConds.push(`_lte: "${today}"`);
    }
    if (releaseFrom) releaseConds.push(`_gte: "${releaseFrom}"`);
    if (releaseTo) releaseConds.push(`_lte: "${releaseTo}"`);
    if (releaseConds.length) {
      conditions.push(`release_date: { ${releaseConds.join(', ')} }`);
    }

    // pages range
    const pagesConds: string[] = [];
    if (typeof pagesMin === 'number' && pagesMin > 0)
      pagesConds.push(`_gte: ${pagesMin}`);
    if (typeof pagesMax === 'number' && pagesMax > 0)
      pagesConds.push(`_lte: ${pagesMax}`);
    if (pagesConds.length) {
      conditions.push(`pages: { ${pagesConds.join(', ')} }`);
    }

    // rating range (1-decimal float)
    const ratingConds: string[] = [];
    if (typeof ratingMin === 'number' && ratingMin > 0)
      ratingConds.push(`_gte: ${ratingMin}`);
    if (typeof ratingMax === 'number' && ratingMax > 0 && ratingMax < 5)
      ratingConds.push(`_lte: ${ratingMax}`);
    if (ratingConds.length) {
      conditions.push(`rating: { ${ratingConds.join(', ')} }`);
    }

    // Tag filter — Hardcover lets anyone tag any book, so a naive existence
    // check matches noise. Require a per-category minimum number of users to
    // have applied a matching tag, AND when ranking by tag we sort by the
    // filtered tagging count so the most-tagged book per genre/mood/tag
    // surfaces first (matching Hardcover's own "Tags Counts" sort).
    const allFilterTagIds: number[] = [];
    const tagAndConds: string[] = [];
    if (tagIds && tagIds.length > 0) {
      const validIds = tagIds.filter((n) => Number.isFinite(n));
      if (validIds.length > 0) {
        const groups = await this.groupTagsByCategory(validIds);
        // The sort step (filtered tag count desc) does the actual ranking.
        // The threshold's only job is to define the candidate pool size and
        // exclude books that were tagged once by a random reviewer.
        //
        // Comics has 76k books tagged but only 10 with >=3 taggings — so a
        // strict floor would shrink the visible result set to 10 even with
        // a 100-book pool. Threshold 2 keeps real comics + a few classics
        // with stray tags; the tag-count sort buries the latter.
        const TAG_THRESHOLDS: Record<number, number> = {
          1: 2, // Genre
          2: 1, // Tag (niche, sparse coverage)
          4: 2, // Mood
        };
        for (const [cat, ids] of groups.entries()) {
          if (!ids.length) continue;
          const threshold = TAG_THRESHOLDS[cat] ?? 3;
          // Each category becomes its own taggings_aggregate sub-filter; we
          // _and them together so a Romance + Funny query returns books that
          // satisfy BOTH thresholds. Putting them as sibling top-level keys
          // would just duplicate the field name and silently overwrite.
          tagAndConds.push(
            `{ taggings_aggregate: { count: { predicate: { _gte: ${threshold} }, filter: { tag_id: { _in: [${ids.join(', ')}] } } } } }`
          );
          allFilterTagIds.push(...ids);
        }
      }
    }
    if (tagAndConds.length === 1) {
      // Strip the wrapping {} when only one category — keeps the query tidy.
      conditions.push(tagAndConds[0].slice(2, -2));
    } else if (tagAndConds.length > 1) {
      conditions.push(`_and: [${tagAndConds.join(', ')}]`);
    }

    const whereClause = `{ ${conditions.join(', ')} }`;

    // When filtering by tags, fetch a wider candidate pool, then sort in code
    // by the filtered tagging count. This matches Hardcover's behavior on
    // their /moods/funny page where Project Hail Mary (190 funny taggings)
    // ranks above Harry Potter (which has more total readers but fewer
    // funny-specific taggings).
    const tagSorted = allFilterTagIds.length > 0;
    // When a tag is selected, fetch a much wider pool so the post-sort by
    // tagging count surfaces the best results. Hardcover caps queries at
    // 100 rows per request; 100 is enough for niche tags and bigger pools
    // would just churn through low-signal books anyway.
    const fetchLimit = tagSorted ? 100 : limit;

    const tagCountField = tagSorted
      ? `tagCount: taggings_aggregate(where: {tag_id: {_in: [${allFilterTagIds.join(', ')}]}}) { aggregate { count } }`
      : '';

    const query = `
      query Discover($limit: Int!, $offset: Int!) {
        books(
          limit: $limit
          offset: $offset
          order_by: { ${orderField}: ${dir} }
          where: ${whereClause}
        ) {
          id
          title
          slug
          release_date
          users_count
          rating
          pages
          description
          image { url }
          contributions(limit: 3) { author { name } }
          ${tagCountField}
        }
      }
    `;
    try {
      const r = await axios.post(
        this.endpoint,
        { query, variables: { limit: fetchLimit, offset } },
        {
          headers: {
            Authorization: this.token,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );
      if (r.data.errors) {
        logger.warn('Hardcover discover returned errors', {
          label: 'Hardcover',
          errors: r.data.errors,
        });
        return [];
      }
      let books = (r.data.data?.books ?? []) as (HardcoverBook & {
        tagCount?: { aggregate?: { count?: number } };
      })[];
      if (tagSorted) {
        books = books
          .slice()
          .sort(
            (a, b) =>
              (b.tagCount?.aggregate?.count ?? 0) -
              (a.tagCount?.aggregate?.count ?? 0)
          )
          .slice(0, limit);
      }
      cache.set(cacheKey, books);
      return books;
    } catch (e) {
      logger.error('Hardcover discover failed', {
        label: 'Hardcover',
        message: (e as Error).message,
      });
      return [];
    }
  }

  private async runBookSearch(
    term: string,
    perPage: number
  ): Promise<HardcoverSearchDocument[]> {
    const query = `
      query Search($q: String!, $perPage: Int!) {
        search(query: $q, per_page: $perPage, page: 1) {
          ids
          error
          results
        }
      }
    `;
    const r = await axios.post<{ data?: { search?: HardcoverSearchOutput } }>(
      this.endpoint,
      { query, variables: { q: term, perPage } },
      {
        headers: {
          Authorization: this.token,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
    const search = r.data?.data?.search;
    if (search?.error) {
      logger.warn('Hardcover search returned an error', {
        label: 'Hardcover',
        term,
        error: search.error,
      });
      return [];
    }
    return (search?.results?.hits ?? [])
      .map((h) => h.document)
      .filter((d): d is HardcoverSearchDocument => !!d);
  }

  private async getPopularBooksByAuthorIds(
    authorIds: number[],
    limit: number
  ): Promise<HardcoverBook[]> {
    if (!authorIds.length) return [];

    const query = `
      query AuthorBooks($authorIds: [Int!]!, $limit: Int!) {
        books(
          where: {
            contributions: { author: { id: { _in: $authorIds } } }
            users_count: { _gt: 0 }
          }
          order_by: { users_count: desc }
          limit: $limit
        ) {
          id
          title
          slug
          release_date
          users_count
          rating
          pages
          description
          image { url }
          contributions(limit: 3) { author { name } }
        }
      }
    `;

    try {
      const r = await axios.post<{ data?: { books?: HardcoverBook[] } }>(
        this.endpoint,
        { query, variables: { authorIds, limit } },
        {
          headers: {
            Authorization: this.token,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );
      return r.data?.data?.books ?? [];
    } catch (e) {
      logger.warn('Hardcover author enrichment failed', {
        label: 'Hardcover',
        authorIds,
        message: (e as Error).message,
      });
      return [];
    }
  }

  public async searchBooks(
    term: string,
    options: { limit?: number; mediaType?: BookSearchMediaType } = {}
  ): Promise<HardcoverBook[]> {
    const cleaned = normalizeSearchText(term);
    if (!cleaned) return [];

    const limit = Math.min(Math.max(options.limit ?? 30, 1), 60);
    const cache = cacheManager.getCache('hardcover').data;
    const cacheKey = `search:v6:${options.mediaType ?? 'book'}:${cleaned}:${limit}`;
    const cached = cache.get<HardcoverBook[]>(cacheKey);
    if (cached) return cached;

    const queries = buildBookSearchQueries(term);
    const rawDocs: HardcoverSearchDocument[] = [];
    const seenDocIds = new Set<number>();

    for (const query of queries) {
      try {
        const docs = await this.runBookSearch(query, limit);
        for (const doc of docs) {
          const id = Number(doc.id);
          if (!Number.isFinite(id) || seenDocIds.has(id)) continue;
          seenDocIds.add(id);
          rawDocs.push(doc);
        }
      } catch (e) {
        logger.error('Hardcover search failed', {
          label: 'Hardcover',
          term: query,
          message: (e as Error).message,
        });
      }
    }

    const authorIds = matchingAuthorIds(rawDocs, term);
    const authorBooks = await this.getPopularBooksByAuthorIds(authorIds, limit);
    for (const book of authorBooks) {
      const id = Number(book.id);
      if (!Number.isFinite(id) || seenDocIds.has(id)) continue;
      seenDocIds.add(id);
      rawDocs.push(hardcoverBookToSearchDocument(book));
    }

    const rankedDocs = rawDocs
      .map((doc) => ({
        doc,
        score: scoreSearchDocument(doc, cleaned, options.mediaType),
      }))
      .sort((a, b) => b.score - a.score)
      .map((r) => r.doc);

    const books = rankedDocs
      .map(searchDocumentToBook)
      .filter((b): b is HardcoverBook => !!b)
      .slice(0, limit);

    cache.set(cacheKey, books, 300);
    return books;
  }

  public async getWantToRead(
    username: string
  ): Promise<{ id: number; title: string; slug: string }[]> {
    const cache = cacheManager.getCache('hardcover').data;
    const cacheKey = `wantToRead:${username.toLowerCase()}`;
    const cached =
      cache.get<{ id: number; title: string; slug: string }[]>(cacheKey);
    if (cached !== undefined) return cached;
    const query = `
      query WantToRead($username: citext!) {
        user_books(
          where: { user: { username: { _eq: $username } }, status_id: { _eq: 1 } }
          limit: 100
          order_by: { date_added: desc }
        ) {
          book { id title slug }
        }
      }
    `;
    try {
      const r = await axios.post(
        this.endpoint,
        { query, variables: { username } },
        {
          headers: {
            Authorization: this.token,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );
      const rows = (r.data?.data?.user_books ?? []) as {
        book: { id: number; title: string; slug: string } | null;
      }[];
      const books = rows
        .map((r) => r.book)
        .filter((b): b is { id: number; title: string; slug: string } => !!b);
      // Cache for 60s — pairs with the 1-min cron so a Want-to-Read mark
      // surfaces within roughly a minute without hammering Hardcover.
      cache.set(cacheKey, books, 60);
      return books;
    } catch (e) {
      logger.error('Hardcover getWantToRead failed', {
        label: 'Hardcover',
        username,
        message: (e as Error).message,
      });
      return [];
    }
  }

  /**
   * Other books by the same author(s) of the given book, ordered by users_count
   * desc. One Hardcover round-trip via a nested aggregate join — the source
   * book's author IDs and the matching books are fetched together.
   */
  public async getMoreByAuthor(
    bookId: number,
    limit = 20
  ): Promise<HardcoverBook[]> {
    const cache = cacheManager.getCache('hardcover').data;
    const cacheKey = `moreByAuthor:${bookId}:${limit}`;
    const cached = cache.get<HardcoverBook[]>(cacheKey);
    if (cached) return cached;
    const query = `
      query MoreByAuthor($id: Int!, $limit: Int!) {
        source: books_by_pk(id: $id) {
          contributions {
            author {
              contributions(
                where: { book: { id: { _neq: $id }, users_count: { _gt: 0 } } }
                order_by: { book: { users_count: desc } }
                limit: $limit
              ) {
                book {
                  id title slug release_date users_count rating pages description
                  image { url }
                  contributions(limit: 3) { author { name } }
                }
              }
            }
          }
        }
      }
    `;
    try {
      const r = await axios.post(
        this.endpoint,
        { query, variables: { id: bookId, limit } },
        {
          headers: {
            Authorization: this.token,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );
      const contributions = (r.data?.data?.source?.contributions ?? []) as {
        author: { contributions: { book: HardcoverBook | null }[] } | null;
      }[];
      const seen = new Set<number>();
      const books: HardcoverBook[] = [];
      for (const c of contributions) {
        for (const inner of c.author?.contributions ?? []) {
          if (!inner.book) continue;
          if (seen.has(inner.book.id)) continue;
          seen.add(inner.book.id);
          books.push(inner.book);
          if (books.length >= limit) break;
        }
        if (books.length >= limit) break;
      }
      books.sort((a, b) => (b.users_count ?? 0) - (a.users_count ?? 0));
      cache.set(cacheKey, books, 3600);
      return books;
    } catch (e) {
      logger.error('Hardcover getMoreByAuthor failed', {
        label: 'Hardcover',
        bookId,
        message: (e as Error).message,
      });
      return [];
    }
  }

  /**
   * Full book detail in a single Hardcover round-trip — used as the primary
   * source for /audiobook/:id and /ebook/:id detail pages so we don't have
   * to wait on Bookshelf's 5-15s chained lookups.
   */
  public async getBookFullDetail(id: number): Promise<{
    id: number;
    title: string;
    slug: string | null;
    release_date: string | null;
    users_count: number;
    rating: number | null;
    pages: number | null;
    description: string | null;
    image: { url: string } | null;
    cached_tags: {
      Genre?: { tag: string }[];
      Mood?: { tag: string }[];
      Tag?: { tag: string }[];
    } | null;
    contributions: {
      author: {
        id: number;
        name: string;
        slug: string | null;
        bio: string | null;
        image: { url: string } | null;
      } | null;
    }[];
    editions: {
      id: number;
      title: string | null;
      pages: number | null;
      release_date: string | null;
      isbn_13: string | null;
      audio_seconds: number | null;
      image: { url: string } | null;
    }[];
  } | null> {
    const cache = cacheManager.getCache('hardcover').data;
    const cacheKey = `fullDetail:${id}`;
    const cached = cache.get<unknown>(cacheKey);
    if (cached !== undefined) return cached as never;
    const query = `
      query FullDetail($id: Int!) {
        books_by_pk(id: $id) {
          id title slug release_date users_count rating pages description
          cached_tags
          image { url }
          contributions {
            author { id name slug bio image { url } }
          }
          editions(limit: 8, order_by: {users_count: desc}) {
            id title pages release_date isbn_13 audio_seconds image { url }
          }
        }
      }
    `;
    try {
      const r = await axios.post(
        this.endpoint,
        { query, variables: { id } },
        {
          headers: {
            Authorization: this.token,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        }
      );
      const row = r.data?.data?.books_by_pk ?? null;
      cache.set(cacheKey, row, 1800);
      return row;
    } catch (e) {
      logger.error('Hardcover getBookFullDetail failed', {
        label: 'Hardcover',
        id,
        message: (e as Error).message,
      });
      return null;
    }
  }

  public async getBookInfo(
    id: number
  ): Promise<{ description: string | null; slug: string | null }> {
    const cache = cacheManager.getCache('hardcover').data;
    const cacheKey = `info:${id}`;
    const cached = cache.get<{
      description: string | null;
      slug: string | null;
    }>(cacheKey);
    if (cached !== undefined) return cached;
    const query = `
      query Info($id: Int!) {
        books_by_pk(id: $id) { description slug }
      }
    `;
    try {
      const r = await axios.post(
        this.endpoint,
        { query, variables: { id } },
        {
          headers: {
            Authorization: this.token,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );
      const row = r.data?.data?.books_by_pk;
      const info = {
        description: row?.description ?? null,
        slug: row?.slug ?? null,
      };
      cache.set(cacheKey, info);
      return info;
    } catch (e) {
      logger.error('Hardcover getBookInfo failed', {
        label: 'Hardcover',
        message: (e as Error).message,
        id,
      });
      return { description: null, slug: null };
    }
  }
}

export default HardcoverAPI;

let cachedClient: HardcoverAPI | null = null;
export function getHardcoverClient(): HardcoverAPI | null {
  if (cachedClient) return cachedClient;
  const token = process.env.HARDCOVER_TOKEN;
  if (!token) {
    logger.warn('HARDCOVER_TOKEN env var not set; discover disabled', {
      label: 'Hardcover',
    });
    return null;
  }
  cachedClient = new HardcoverAPI(token);
  return cachedClient;
}
