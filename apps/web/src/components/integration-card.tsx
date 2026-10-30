import {
  CalendarDays,
  Cloud,
  Code2,
  Globe,
  Megaphone,
  PlayCircle,
  Settings2,
  Share2,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { IntegrationStatus, Provider, UserIntegration } from '@/lib/types';

// Generic icons on purpose: no third-party brand marks are bundled.
const ICONS: Record<string, LucideIcon> = {
  openai: Sparkles,
  gemini: Sparkles,
  google: Globe,
  google_drive: Cloud,
  google_calendar: CalendarDays,
  youtube: PlayCircle,
  meta: Megaphone,
  x: Share2,
  github: Code2,
};

export const STATUS_META: Record<IntegrationStatus, { label: string; dot: string; badge: string }> = {
  NOT_CONNECTED: { label: 'Not connected', dot: 'bg-muted-dark', badge: 'bg-cream-200 text-ink-600' },
  CONFIGURED: { label: 'Configured', dot: 'bg-amber-500', badge: 'bg-amber-100 text-amber-800' },
  CONNECTED: { label: 'Connected', dot: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-800' },
  ERROR: { label: 'Error', dot: 'bg-red-500', badge: 'bg-red-100 text-red-700' },
};

export function ProviderIcon({ providerKey, className }: { providerKey: string; className?: string }) {
  const Icon = ICONS[providerKey] ?? Globe;
  return (
    <span className={cn('flex h-11 w-11 items-center justify-center rounded-2xl bg-ink text-accent', className)}>
      <Icon className="h-5 w-5" />
    </span>
  );
}

export function IntegrationCard({
  provider,
  integration,
  isDefault,
  busy,
  onConnect,
  onConfigure,
  onDisconnect,
}: {
  provider: Provider;
  integration?: UserIntegration;
  isDefault?: boolean;
  busy?: boolean;
  onConnect: () => void;
  onConfigure: () => void;
  onDisconnect: () => void;
}) {
  const status: IntegrationStatus = integration?.status ?? 'NOT_CONNECTED';
  const meta = STATUS_META[status];
  const active = status === 'CONNECTED' || status === 'CONFIGURED';

  return (
    <Card className="flex flex-col p-5 transition-shadow hover:shadow-lift">
      <div className="flex items-start justify-between gap-3">
        <ProviderIcon providerKey={provider.key} />
        <Badge className={meta.badge}>
          <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} />
          {meta.label}
        </Badge>
      </div>

      <div className="mt-4 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="font-sans text-[15px] font-semibold">{provider.name}</h3>
          {isDefault && <Badge className="bg-accent-soft text-accent-hover">Default AI</Badge>}
        </div>
        <p className="mt-0.5 text-xs uppercase tracking-wider text-muted">{provider.category}</p>
        <p className="mt-2 text-sm text-muted">{provider.description}</p>

        {integration?.displayName && active && (
          <p className="mt-3 truncate rounded-lg bg-cream-100 px-3 py-2 font-mono text-xs text-ink-600">
            {integration.maskedCredential ?? integration.displayName}
          </p>
        )}
        {status === 'ERROR' && integration?.displayName && (
          <p className="mt-3 text-xs text-red-600">{integration.displayName}</p>
        )}
      </div>

      <div className="mt-5 flex items-center gap-2">
        {active ? (
          <>
            <Button size="sm" variant="outline" onClick={onConfigure} disabled={busy}>
              <Settings2 className="h-3.5 w-3.5" />
              Configure
            </Button>
            <Button size="sm" variant="ghost" onClick={onDisconnect} disabled={busy}>
              Disconnect
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" onClick={onConnect} loading={busy}>
              {provider.authType === 'api_key' ? 'Add API key' : status === 'ERROR' ? 'Reconnect' : 'Connect'}
            </Button>
            {status === 'ERROR' && (
              <Button size="sm" variant="ghost" onClick={onDisconnect} disabled={busy}>
                Disconnect
              </Button>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
