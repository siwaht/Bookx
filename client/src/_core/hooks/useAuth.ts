import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useMemo } from "react";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

/**
 * A network-level failure (server down, connection refused), not a tRPC error
 * the server chose to send. Such a failure says nothing about the session: the
 * cookie may be perfectly fine, so it must never be treated as "signed out".
 */
export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TRPCClientError) {
    // "Failed to fetch" / "fetch failed": the request never got an HTTP answer.
    return /failed to fetch|network error|load failed/i.test(error.message);
  }
  return true; // Anything that is not a tRPC error came from the transport.
}

export function useAuth(options?: UseAuthOptions) {
  // Login is started via startLogin() in the effect below, only when we actually
  // navigate — never during render. startLogin() mints a one-time nonce + writes
  // the state cookie, so calling it per render would overwrite the cookie and
  // desync it from an in-flight login's `state`.
  const { redirectOnUnauthenticated = false, redirectPath } = options ?? {};
  const utils = trpc.useUtils();

  const meQuery = trpc.auth.me.useQuery(undefined, {
    // A refused connection is the server being down, not a signed-out session;
    // retry so the app recovers by itself once the server is back. A real 401
    // (UNAUTHORIZED) is still answered immediately — see `retry` below.
    retry: (failureCount, error) => {
      if (isNetworkFailure(error)) return failureCount < 6;
      return false;
    },
    retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 15_000),
    refetchOnWindowFocus: false,
    // When the server comes back, a background refetch picks the session up
    // again instead of leaving the tab stuck on "signed out" forever.
    refetchOnReconnect: true,
  });

  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => {
      utils.auth.me.setData(undefined, null);
    },
  });

  const logout = useCallback(async () => {
    try {
      await logoutMutation.mutateAsync();
    } catch (error: unknown) {
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "UNAUTHORIZED"
      ) {
        return;
      }
      throw error;
    } finally {
      // Clear the Preview auto-login token mirrored into sessionStorage, so
      // header-based sessions (Safari ITP / WebView) are logged out too. The
      // backend cookie is cleared by the logout mutation.
      try {
        sessionStorage.removeItem("manus-cookie");
      } catch {}
      utils.auth.me.setData(undefined, null);
      await utils.auth.me.invalidate();
    }
  }, [logoutMutation, utils]);

  useEffect(() => {
    try {
      localStorage.setItem("manus-runtime-user-info", JSON.stringify(meQuery.data));
    } catch {
      // Storage may be unavailable in privacy-restricted browser contexts.
    }
  }, [meQuery.data]);

  const state = useMemo(() => {
    // The server could not be reached: the session is unknown, not absent.
    // Panels use this to say "reconnecting" instead of "sign in".
    const offline = Boolean(meQuery.error && isNetworkFailure(meQuery.error));
    return {
      user: meQuery.data ?? null,
      loading: meQuery.isLoading || logoutMutation.isPending,
      error: meQuery.error ?? logoutMutation.error ?? null,
      offline,
      // While offline the session is unknown; claiming "not signed in" here is
      // what made a dead server look like a sign-in problem.
      isAuthenticated: offline ? false : Boolean(meQuery.data),
    };
  }, [
    meQuery.data,
    meQuery.error,
    meQuery.isLoading,
    logoutMutation.error,
    logoutMutation.isPending,
  ]);

  useEffect(() => {
    if (!redirectOnUnauthenticated) return;
    if (meQuery.isLoading || logoutMutation.isPending) return;
    if (state.user) return;
    // Never redirect to the sign-in page because the server is unreachable;
    // that is a connection problem, not an authentication problem.
    if (state.offline) return;
    if (typeof window === "undefined") return;
    if (redirectPath && window.location.pathname === redirectPath) return;

    // Navigate at this moment only. startLogin() mints the nonce + cookie itself.
    if (redirectPath) {
      window.location.href = redirectPath;
    } else {
      startLogin({ automatic: true });
    }
  }, [
    redirectOnUnauthenticated,
    redirectPath,
    logoutMutation.isPending,
    meQuery.isLoading,
    state.user,
    state.offline,
  ]);

  return {
    ...state,
    refresh: () => meQuery.refetch(),
    logout,
  };
}
