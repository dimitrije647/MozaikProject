import { Moon, Sun } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { SettingsSection } from '@/components/settings-section';

// PLACEHOLDER: only the cream theme exists. Dark mode is not implemented.
export default function AppearanceSettingsPage() {
  return (
    <SettingsSection title="Theme" description="Choose how LaunchPilot looks.">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border-2 border-accent bg-cream-50 p-4">
          <div className="mb-3 flex h-20 items-end gap-1.5 rounded-xl bg-cream p-2.5">
            <div className="h-full w-6 rounded-md bg-cream-200" />
            <div className="h-full flex-1 rounded-md bg-ink" />
          </div>
          <p className="flex items-center gap-2 text-sm font-medium"><Sun className="h-4 w-4" /> Cream <Badge className="bg-accent-soft text-accent-hover">Active</Badge></p>
        </div>
        <div className="cursor-not-allowed rounded-2xl border border-cream-300 bg-cream-50 p-4 opacity-60">
          <div className="mb-3 flex h-20 items-end gap-1.5 rounded-xl bg-ink p-2.5">
            <div className="h-full w-6 rounded-md bg-ink-700" />
            <div className="h-full flex-1 rounded-md bg-ink-800" />
          </div>
          <p className="flex items-center gap-2 text-sm font-medium"><Moon className="h-4 w-4" /> Dark <Badge className="bg-cream-200 text-muted">Coming soon</Badge></p>
        </div>
      </div>
    </SettingsSection>
  );
}
