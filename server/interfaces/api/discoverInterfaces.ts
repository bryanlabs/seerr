export interface GenreSliderItem {
  id: number;
  name: string;
  backdrops: string[];
}

import type { MediaType } from '@server/constants/media';

export interface WatchlistItem {
  id: number;
  ratingKey: string;
  tmdbId: number;
  mediaType: MediaType;
  title: string;
}

export interface WatchlistResponse {
  page: number;
  totalPages: number;
  totalResults: number;
  results: WatchlistItem[];
}
