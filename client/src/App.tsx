import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "@/pages/Home";
import Login from "@/pages/Login";
import NotFound from "@/pages/NotFound";
import { LOGIN_PATH } from "@/const";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";

function Router() {
  // make sure to consider if you need authentication for certain routes
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={LOGIN_PATH} component={Login} />
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="light"
        // switchable
      >
        <TooltipProvider>
          <Toaster
            position="bottom-right"
            closeButton
            // The toasts are paper cards, so pin sonner's light palette rather
            // than following the OS setting.
            theme="light"
            toastOptions={{
              style: {
                background: "var(--color-paper)",
                color: "var(--color-ink-900)",
                borderRadius: "14px",
                fontFamily: "var(--font-sans)",
                fontSize: "13px",
                fontWeight: 600,
                border: "1px solid var(--color-stone-150)",
                boxShadow: "var(--shadow-float)",
              },
              classNames: { description: "text-ink-500! font-normal!" },
            }}
          />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
