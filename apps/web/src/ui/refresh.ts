// Every page updates by itself; there is no Refresh button (v3 SV-10). A page reads its data through usePageQuery or
// usePageInfiniteQuery with a pace that fits the data. TanStack Query keeps what is shown when a read fails, reads
// nothing while the browser tab is hidden and catches up when it is shown again, and keeps unchanged data identical,
// so React redraws only what changed. guards.test.ts fails on a page that registers no refresh of its own.

import {
  type InfiniteData,
  keepPreviousData,
  type QueryKey,
  type UseInfiniteQueryResult,
  type UseQueryResult,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query"

/** Paces, in milliseconds. */
export const EVERY = {
  /** The audit log and the users: they change while an admin looks. */
  live: 30_000,
  /** Settings and the signed-in sessions change rarely. */
  slow: 300_000,
} as const

export function usePageQuery<T>(options: {
  queryKey: QueryKey
  queryFn: () => Promise<T>
  every: number
  enabled?: boolean
}): UseQueryResult<T> {
  return useQuery({
    queryKey: options.queryKey,
    queryFn: options.queryFn,
    enabled: options.enabled,
    refetchInterval: options.every,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
}

/** A list that loads more by a cursor after its last row; a refresh reads every page shown again. */
export function usePageInfiniteQuery<P, C>(options: {
  queryKey: QueryKey
  queryFn: (cursor: C | null) => Promise<P>
  nextCursor: (page: P) => C | null
  every: number
  enabled?: boolean
  /** A list whose key follows its filters: the rows shown stay until the new answer replaces them (TB-5). */
  keepPrevious?: boolean
}): UseInfiniteQueryResult<InfiniteData<P, C | null>> {
  return useInfiniteQuery({
    queryKey: options.queryKey,
    queryFn: ({ pageParam }) => options.queryFn(pageParam as C | null),
    initialPageParam: null as C | null,
    getNextPageParam: (last) => options.nextCursor(last) ?? undefined,
    enabled: options.enabled,
    placeholderData: options.keepPrevious ? keepPreviousData : undefined,
    refetchInterval: options.every,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
}
