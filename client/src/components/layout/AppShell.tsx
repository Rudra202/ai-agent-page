import { Building2, Sparkles, SquarePen } from 'lucide-react';
import { useEffect } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { greeting } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { useApp } from '../../state/context';
import { ErrorState, LoadingState } from '../ui/StateViews';
import { isNavActive, NAV_ITEMS } from './navItems';

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-9 items-center justify-center rounded-control bg-navy-900 text-white">
        <Sparkles className="size-5" aria-hidden />
      </span>
      <span className="text-lg font-bold tracking-tight text-navy-900">Tajir AI</span>
    </div>
  );
}

function AppHeader() {
  const { state, newChat } = useApp();
  const navigate = useNavigate();
  const now = useNow();
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-surface/90 px-4 py-2.5 backdrop-blur md:px-8">
      <div className="min-w-0">
        <p className="truncate text-xs text-muted">
          {greeting(now)}, {state.user.firstName}
        </p>
        <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-navy-900">
          <Building2 className="size-4 shrink-0 text-brand-600" aria-hidden />
          {state.user.company || state.user.name}
        </p>
      </div>
      <button
        type="button"
        aria-label="New chat"
        title="New chat"
        onClick={() => {
          void newChat();
          navigate('/chat');
        }}
        className="flex size-10 items-center justify-center rounded-control text-navy-800 hover:bg-brand-50"
      >
        <SquarePen className="size-5" aria-hidden />
      </button>
    </header>
  );
}

/**
 * Responsive application frame: sidebar on desktop, a greeting header on every
 * size, and a bottom navigation bar on phones.
 */
export function AppShell() {
  const { pathname } = useLocation();
  const { state, reload } = useApp();

  // A new page starts at the top. The chat is excluded because it scrolls itself to the newest message.
  useEffect(() => {
    if (pathname !== '/chat') window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_1fr]">
      <aside className="hidden border-r border-line bg-surface md:block">
        <div className="sticky top-0 flex h-dvh flex-col gap-8 p-5">
          <Brand />
          <nav aria-label="Primary" className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => {
              const active = isNavActive(item, pathname);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-control px-3 py-2.5 text-sm font-medium transition-colors',
                    active ? 'bg-brand-50 text-brand-700' : 'text-muted hover:bg-canvas hover:text-navy-900',
                  )}
                >
                  <item.icon className="size-5" aria-hidden />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-col">
        <AppHeader />
        <p className="bg-brand-50 px-4 py-1 text-center text-[11px] font-medium text-brand-700">
          Prototype · sample data · nothing is filed with any authority
        </p>
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-6 pt-5 md:px-8 md:pb-10 md:pt-8">
          {state.load.status === 'loading' ? (
            <LoadingState label="Loading your data..." />
          ) : state.load.status === 'error' ? (
            <ErrorState title="Could not load your data" message={state.load.error ?? 'Please try again.'} onRetry={() => void reload()} />
          ) : (
            <Outlet />
          )}
        </main>
        <div aria-hidden className="h-[var(--nav-h)] md:hidden" />
      </div>

      <nav
        aria-label="Primary mobile"
        className="pb-safe fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur md:hidden"
      >
        <ul className="mx-auto flex max-w-md items-stretch justify-around px-2 pt-1.5">
          {NAV_ITEMS.map((item) => {
            const active = isNavActive(item, pathname);
            return (
              <li key={item.to} className="flex-1">
                <Link
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex flex-col items-center gap-0.5 rounded-control py-1.5 text-[11px] font-medium',
                    active ? 'text-brand-700' : 'text-muted',
                  )}
                >
                  <item.icon className="size-5" aria-hidden />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
