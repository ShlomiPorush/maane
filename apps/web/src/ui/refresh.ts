import {
  type InfiniteData,
  keepPreviousData,
  type QueryKey,
  type UseInfiniteQueryResult,
  type UseQueryResult,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query"

export const EVERY = {
  live: 30_000,
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

export function usePageInfiniteQuery<P, C>(options: {
  queryKey: QueryKey
  queryFn: (cursor: C | null) => Promise<P>
  nextCursor: (page: P) => C | null
  every: number
  enabled?: boolean
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
