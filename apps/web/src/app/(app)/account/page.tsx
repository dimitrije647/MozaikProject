'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, FolderKanban, KeyRound, LogOut, Plug, UserCog } from 'lucide-react';
import { Avatar } from '@/components/app-shell';
import { SectionHeader } from '@/components/section-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/stat-card';
import { post } from '@/lib/api';
import { useMe, useMyIntegrations, useProjects } from '@/lib/hooks';
import { formatDate } from '@/lib/utils';

export default function AccountPage() {
  const me = useMe();
  const projects = useProjects();
  const mine = useMyIntegrations();
  const router = useRouter();
  const qc = useQueryClient();
  const user = me.data;
  if (!user) return null;

  async function logout() {
    await post('/auth/logout').catch(() => undefined);
    qc.clear();
    router.replace('/login');
  }

  const links = [
    { href: '/settings/profile', icon: UserCog, title: 'Profile', body: 'Name and avatar' },
    { href: '/settings/security', icon: KeyRound, title: 'Security', body: 'Change your password' },
    { href: '/settings/integrations', icon: Plug, title: 'Integrations', body: 'Connect Google, Meta, X, GitHub…' },
    { href: '/settings/providers', icon: FolderKanban, title: 'AI providers', body: 'Bring your own OpenAI or Gemini key' },
  ];

  return (
    <div className="space-y-8">
      <SectionHeader eyebrow="Account" title="Your account" description="A quick overview of who you are in LaunchPilot." />

      <Card className="flex flex-wrap items-center gap-5 p-6">
        <Avatar name={user.name} url={user.avatarUrl} className="h-16 w-16 text-xl" />
        <div className="min-w-0 flex-1">
          <p className="font-serif text-2xl">{user.name}</p>
          <p className="text-sm text-muted">{user.email}</p>
          {user.createdAt && <p className="mt-1 text-xs text-muted">Member since {formatDate(user.createdAt)}</p>}
        </div>
        <Button variant="outline" onClick={logout}><LogOut className="h-4 w-4" /> Log out</Button>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Projects" value={projects.data?.length ?? '–'} icon={FolderKanban} />
        <StatCard
          label="Integrations"
          value={mine.data?.integrations.filter((i) => i.status === 'CONNECTED' || i.status === 'CONFIGURED').length ?? '–'}
          icon={Plug}
        />
        <StatCard label="Default AI" value={<span className="text-3xl capitalize">{mine.data?.defaultAiProvider ?? 'None'}</span>} icon={KeyRound} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {links.map((l) => (
          <Link key={l.href} href={l.href}>
            <Card className="group flex items-center gap-4 p-5 transition-shadow hover:shadow-lift">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-ink text-accent"><l.icon className="h-5 w-5" /></span>
              <span className="flex-1">
                <span className="block text-sm font-semibold">{l.title}</span>
                <span className="block text-xs text-muted">{l.body}</span>
              </span>
              <ChevronRight className="h-4 w-4 text-muted transition-transform group-hover:translate-x-0.5" />
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
