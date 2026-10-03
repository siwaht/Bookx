import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Home } from "lucide-react";
import { useLocation } from "wouter";

export default function NotFound() {
  const [, setLocation] = useLocation();

  const handleGoHome = () => {
    setLocation("/");
  };

  return (
    <div className="noise-bg relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-paper-100 px-4 py-10">
      <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2 h-[min(52rem,140vw)] w-[min(52rem,140vw)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[repeating-radial-gradient(circle_at_center,transparent_0_40px,rgb(34_95_97/.06)_40px_41px)] [mask-image:radial-gradient(circle_at_center,black_0_30%,transparent_70%)]" />
      <Card className="fade-up relative w-full max-w-lg gap-0 rounded-panel border-stone-150 bg-paper/95 py-0 shadow-float backdrop-blur-sm">
        <CardContent className="px-8 py-11 text-center">
          <div className="mb-6 flex justify-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-clay-50 text-clay-600 ring-1 ring-clay-100">
              <AlertCircle className="h-7 w-7" strokeWidth={1.75} />
            </span>
          </div>

          <h1 className="serif mb-2 text-[76px] leading-none tracking-[-.03em] text-ink-950">404</h1>

          <h2 className="mb-4 text-lg font-semibold text-ink-800">
            Page Not Found
          </h2>

          <p className="mb-8 leading-relaxed text-ink-500">
            Sorry, the page you are looking for doesn't exist.
            <br />
            It may have been moved or deleted.
          </p>

          <div
            id="not-found-button-group"
            className="flex flex-col justify-center gap-3 sm:flex-row"
          >
            <Button
              onClick={handleGoHome}
              className="h-11 rounded-[0.875rem] bg-brand-700 px-6 text-sm font-semibold text-paper shadow-[inset_0_1px_0_rgb(255_255_255/.12),0_1px_2px_rgb(11_41_44/.2)] hover:bg-brand-800"
            >
              <Home className="mr-2 h-4 w-4" />
              Go Home
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
