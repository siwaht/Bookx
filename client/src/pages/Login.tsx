import { Headphones } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { LOGIN_PATH } from "@/const";

/**
 * The sign-in page for the one Bookx account: email + password, checked by
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
    <main className="noise-bg flex min-h-screen items-center justify-center bg-[#f7f5ef] px-5 py-10 text-[#203038]">
      <div className="fade-up w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-[14px] bg-[#245f63] text-white shadow-[0_8px_20px_rgba(36,95,99,.22)]">
            <Headphones size={19} />
          </span>
          <span>
            <span className="block text-[17px] font-bold tracking-[-.04em]">Bookx</span>
            <span className="block text-[10px] tracking-[.14em] text-[#718084]">AUDIO WORKSPACE</span>
          </span>
        </div>

        <div className="panel-shadow rounded-[26px] border border-[#dfe5dd] bg-[#fffefa] p-7">
          <h1 className="serif text-3xl tracking-[-.04em] text-[#203438]">Welcome back</h1>
          <p className="mt-2 text-sm leading-6 text-[#647276]">Sign in to your studio.</p>

          {config && !config.configured && (
            <p className="mt-4 rounded-xl border border-[#e8d5b5] bg-[#faf3e3] px-4 py-3 text-xs leading-5 text-[#8a6d3b]">
              Sign-in is not configured on the server. Set <code className="mono">BOOKX_SIGNIN_EMAIL</code> and{" "}
              <code className="mono">BOOKX_SIGNIN_PASSWORD</code> in the environment, then restart.
            </p>
          )}

          <form onSubmit={submit} className="mt-6 grid gap-4">
            <label className="grid gap-1.5">
              <span className="text-xs font-semibold tracking-[.06em] text-[#526065]">EMAIL</span>
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
              <span className="text-xs font-semibold tracking-[.06em] text-[#526065]">PASSWORD</span>
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
              <p role="alert" className="rounded-xl border border-[#eccfce] bg-[#fbeae5] px-4 py-3 text-xs leading-5 text-[#a04a2f]">
                {error}
              </p>
            )}

            <button type="submit" disabled={submitting} className="btn-primary mt-1 w-full py-2.5 text-sm">
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-[#8a979a]">Bookx · your private audio studio</p>
      </div>
    </main>
  );
}
