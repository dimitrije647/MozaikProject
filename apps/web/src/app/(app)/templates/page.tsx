'use client';

import * as React from 'react';
import { Info } from 'lucide-react';
import { CollectionGallery } from '@/components/collection-gallery';
import { SectionHeader } from '@/components/section-header';
import { TemplateGallery } from '@/components/template-gallery';
import { cn } from '@/lib/utils';

type Tab = 'collections' | 'templates';

export default function TemplatesPage() {
  const [tab, setTab] = React.useState<Tab>('collections');
  const [style, setStyle] = React.useState('');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'collections', label: 'Collections' },
    { id: 'templates', label: 'All templates' },
  ];

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Hybrid Production"
        title="Template collections"
        description="Ten complete design languages. A collection fixes the typography, shapes, buttons, picture treatment and decoration of every creative of a campaign; you choose one in the campaign design."
      />

      <div className="flex items-start gap-3 rounded-2xl border border-cream-300 bg-cream-50 px-4 py-3 text-sm text-ink-700">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
        <p>Previews are drawn by LaunchPilot&apos;s own renderer with sample text and a placeholder picture. In a campaign, your copy, your logo and your pictures are used.</p>
      </div>

      <div role="tablist" aria-label="Template sections" className="flex flex-wrap gap-1 border-b border-cream-300/80">
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            type="button"
            data-testid={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={cn('-mb-px border-b-2 px-4 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50', tab === t.id ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Both panels stay mounted so the gallery keeps its filters while you look at a collection. */}
      <div id="panel-collections" role="region" aria-labelledby="tab-collections" hidden={tab !== 'collections'}>
        <CollectionGallery />
      </div>
      <div id="panel-templates" role="region" aria-labelledby="tab-templates" hidden={tab !== 'templates'}>
        <TemplateGallery style={style} onStyleChange={setStyle} />
      </div>
    </div>
  );
}
