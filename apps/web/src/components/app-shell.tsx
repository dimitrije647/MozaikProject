'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  FolderKanban,
  Layers,
  LayoutDashboard,
  LayoutTemplate,
  LogOut,
  Menu,
  Plug,
  Plus,
  Settings,
  UserCircle2,
  X,
} from 'lucide-react';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { post } from '@/lib/api';
import { useMe, useProjects } from '@/lib/hooks';
import { cn, initials } from '@/lib/utils';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const projects = useProjects();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => setOpen(false), [pathname]);
  // Session expired or never existed: back to login.
  React.useEffect(() => {
    if (me.isError) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [me.isError, router, pathname]);

  // "Workspace" jumps into the most recently updated project.
  const latest = projects.data?.[0];
  const nav = [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/projects', label: 'Projects', icon: FolderKanban },
    { href: latest ? `/projects/${latest.id}/workspace` : '/projects', label: 'Workspace', icon: Layers, match: '/workspace' },
    { href: '/templates', label: 'Templates', icon: LayoutTemplate },
    { href: '/settings/integrations', label: 'Integrations', icon: Plug, match: '/settings/integrations' },
    { href: '/account', label: 'Account', icon: UserCircle2 },
    { href: '/settings', label: 'Settings', icon: Settings, exclude: '/settings/integrations' },
  ];

  const isActive = (item: (typeof nav)[number]) => {
    if (item.match) return pathname.includes(item.match);
    if (item.exclude && pathname.startsWith(item.exclude)) return false;
    return pathname === item.href || pathname.startsWith(item.href + '/');
  };

  async function logout() {
    await post('/auth/logout').catch(() => undefined);
    qc.clear();
    router.replace('/login');
  }

  if (me.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-cream-300 border-t-accent" />
      </div>
    );
  }
  if (!me.data) return null;
  const user = me.data;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-6 pt-1">
        <Logo href="/dashboard" />
      </div>
      <Button asChild className="mb-5 w-full">
        <Link href="/projects/new">
          <Plus className="h-4 w-4" />
          New project
        </Link>
      </Button>
      <nav className="space-y-1">
        {nav.map((item) => (
          <Link
            key={item.label}
            href={item.href}
            className={cn(
              'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
              isActive(item) ? 'bg-ink text-cream-100 shadow-soft' : 'text-ink-600 hover:bg-cream-200/70',
            )}
          >
            <item.icon className={cn('h-[18px] w-[18px]', isActive(item) && 'text-accent')} />
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="mt-auto rounded-2xl bg-ink p-4 text-cream-100">
        <p className="font-serif text-lg leading-snug">Discovery is live.</p>
        <p className="mt-1 text-xs text-muted-dark">
          Run Product Discovery from any project workspace with your own OpenAI key. More agents are coming.
        </p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-cream-300/70 bg-cream-100/60 p-4 lg:block">
        {sidebar}
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 animate-slide-in bg-cream p-4">{sidebar}</aside>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-cream-300/70 bg-cream/85 px-4 backdrop-blur-md sm:px-8">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen((v) => !v)} aria-label="Menu">
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
          <div className="flex-1" />
          <Button asChild size="sm" variant="outline" className="hidden sm:inline-flex">
            <Link href="/settings/integrations">
              <Plug className="h-3.5 w-3.5" />
              Integrations
            </Link>
          </Button>
          <div className="group relative">
            <button
              className="flex items-center gap-2.5 rounded-full border border-cream-300 bg-cream-50 py-1 pl-1 pr-3.5 transition-colors hover:bg-cream-100"
              aria-label="Account menu"
            >
              <Avatar name={user.name} url={user.avatarUrl} />
              <span className="hidden text-sm font-medium sm:block">{user.name}</span>
            </button>
            <div className="invisible absolute right-0 top-full w-56 pt-2 opacity-0 transition-all group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
              <div className="rounded-2xl border border-cream-300 bg-cream-50 p-1.5 shadow-lift">
                <div className="px-3 py-2">
                  <p className="truncate text-sm font-medium">{user.name}</p>
                  <p className="truncate text-xs text-muted">{user.email}</p>
                </div>
                <Link href="/account" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-cream-200">
                  <UserCircle2 className="h-4 w-4" /> Account
                </Link>
                <Link href="/settings" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-cream-200">
                  <Settings className="h-4 w-4" /> Settings
                </Link>
                <button onClick={logout} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50">
                  <LogOut className="h-4 w-4" /> Log out
                </button>
              </div>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl animate-fade-up px-4 py-8 sm:px-8 sm:py-10">{children}</main>
      </div>
    </div>
  );
}

export function Avatar({ name, url, className }: { name: string; url?: string | null; className?: string }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={name} className={cn('h-8 w-8 rounded-full object-cover', className)} />;
  }
  return (
    <span className={cn('flex h-8 w-8 items-center justify-center rounded-full bg-ink text-xs font-semibold text-cream-100', className)}>
      {initials(name)}
    </span>
  );
}
