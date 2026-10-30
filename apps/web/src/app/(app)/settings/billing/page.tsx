import { CreditCard } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';

// PLACEHOLDER: billing is out of scope for this phase.
export default function BillingSettingsPage() {
  return (
    <Card className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h3 className="font-sans text-[15px] font-semibold">Plan</h3>
          <p className="mt-1 text-sm text-muted">You are on the free preview plan.</p>
        </div>
        <Badge className="bg-cream-200 text-ink-600">Placeholder</Badge>
      </div>
      <EmptyState
        icon={CreditCard}
        title="Billing is not available yet"
        description="Because you bring your own AI keys, billing will cover the platform only. Nothing is charged during the preview."
      />
    </Card>
  );
}
