import { Headphones } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { LOGIN_PATH } from "@/const";

/**
 * The sign-in page for the one Prosecast account: email + password, checked by
 * the server (see server/_core/passwordAuth.ts). On success the server sets
 * the session cookie and the visitor returns to where they came from.
 */

type Config = { configured: boolean; email: string | null };

function safeReturnPath(value: string | null): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value === LOGIN_PATH) return "/";
  return value;
}

export default function Login() {
  const { isAuthenticated } = useAuth();
  const [config, setConfig] = useState<Config | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const returnTo = safeReturnPath(new URLSearchParams(window.location.search).get("returnTo"));

  // Already signed in: go straight back.
  useEffect(() => {
    if (isAuthenticated) window.location.href = returnTo;
  }, [isAuthenticated, returnTo]);

  // Which credentials the server expects (never the password itself).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/config")
      .then(response => response.json())
      .then((data: Config) => {
        if (!cancelled) setConfig(data);
      })
      .catch(() => {
        if (!cancelled) setConfig({ configured: false, email: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Sign-in failed. Try again.");
        setSubmitting(false);
        return;
      }
      window.location.href = returnTo;
    } catch {
      setError("Sign-in failed. Check your connection and try again.");
      setSubmitting(false);
    }
  };

  return (
    <main className="noise-bg relative flex min-h-screen items-center justify-center overflow-hidden bg-paper-100 px-5 py-10 text-ink-900">
      <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2 h-[min(52rem,140vw)] w-[min(52rem,140vw)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[repeating-radial-gradient(circle_at_center,transparent_0_40px,rgb(34_95_97/.06)_40px_41px)] [mask-image:radial-gradient(circle_at_center,black_0_30%,transparent_70%)]" />
      <div className="fade-up relative w-full max-w-[400px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="brand-mark h-12 w-12 rounded-2xl">
            <Headphones size={20} strokeWidth={1.75} />
          </span>
          <span className="serif mt-4 block text-[30px] leading-none tracking-[-.01em] text-ink-950">Prosecast</span>
          <span className="eyebrow mt-2 block text-3xs tracking-[.22em] text-ink-500">AUDIO WORKSPACE</span>
        </div>

        <div className="rounded-panel border border-stone-150 bg-paper/95 p-7 shadow-float backdrop-blur-sm sm:p-8">
          <h1 className="serif text-[32px] leading-tight tracking-[-.02em] text-ink-950">Welcome back</h1>
          <p className="mt-1.5 text-sm leading-6 text-ink-500">Sign in to your studio.</p>

          {config && !config.configured && (
            <p className="mt-5 rounded-xl border border-gold-200 bg-gold-50 px-4 py-3 text-xs leading-5 text-gold-800">
              Sign-in is not configured on the server. Set <code className="mono">BOOKX_SIGNIN_EMAIL</code> and{" "}
              <code className="mono">BOOKX_SIGNIN_PASSWORD</code> in the environment, then restart.
            </p>
          )}

          <form onSubmit={submit} className="mt-7 grid gap-4">
            <label className="grid gap-1.5">
              <span className="eyebrow text-3xs text-ink-600">EMAIL</span>
              <input
                className="input"
                type="email"
                name="email"
                autoComplete="username"
                required
                value={email}
                onChange={event => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <label className="grid gap-1.5">
              <span className="eyebrow text-3xs text-ink-600">PASSWORD</span>
              <input
                className="input"
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={event => setPassword(event.target.value)}
                placeholder="Your password"
              />
            </label>

            {error && (
              <p role="alert" className="rounded-xl border border-clay-200 bg-clay-50 px-4 py-3 text-xs leading-5 text-clay-700">
                {error}
              </p>
            )}

            <button type="submit" disabled={submitting} className="btn-primary btn-lg mt-2 w-full">
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>

        <p className="mt-8 text-center text-xs text-ink-500">Prosecast · your private audio studio</p>
      </div>
    </main>
  );
}
