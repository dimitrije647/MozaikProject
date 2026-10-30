import Link from 'next/link';
import {
  ArrowRight,
  BarChart3,
  CalendarRange,
  Check,
  FileSearch,
  FolderKanban,
  Layers,
  Palette,
  Plug,
  Rocket,
  Search,
  Sparkles,
  UploadCloud,
} from 'lucide-react';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';

const features = [
  { icon: UploadCloud, title: 'One structured brief', body: 'Product, assets, audience, goals and channels captured once, in a form built for AI agents to consume.' },
  { icon: Search, title: 'SEO audit', body: 'Switch on a site audit so strategy starts from what your product and website actually say today.' },
  { icon: CalendarRange, title: 'Seasonal calendar', body: 'Plan around launches, holidays and local seasons instead of posting into the void.' },
  { icon: Palette, title: 'Multi-format creative', body: 'Instagram, LinkedIn, banners, flyers, even billboards. Pick the formats, keep the brand.' },
  { icon: Plug, title: 'Bring your own keys', body: 'Connect OpenAI or Gemini with your own API key, encrypted on our side and used only by your agents.' },
  { icon: Layers, title: 'Everything in one workspace', body: 'Intelligence, audit, strategy, creative and export live together, per campaign.' },
];

const steps = [
  { n: '01', title: 'Brief it', body: 'Describe your product, upload your logo and screenshots, link your socials.' },
  { n: '02', title: 'Configure it', body: 'Choose goals, languages, creative style and the integrations you want connected.' },
  { n: '03', title: 'Launch it', body: 'Your AI marketing team picks it up from the workspace. Agents arrive in a later phase.' },
];

const integrations = ['OpenAI', 'Gemini', 'Google', 'Google Drive', 'Calendar', 'YouTube', 'Meta', 'X', 'GitHub'];

export default function LandingPage() {
  return (
    <div className="overflow-x-hidden">
      <header className="mx-auto flex h-20 max-w-6xl items-center justify-between px-6">
        <Logo />
        <nav className="hidden items-center gap-8 text-sm text-ink-600 md:flex">
          <a href="#features" className="hover:text-ink">Features</a>
          <a href="#how" className="hover:text-ink">How it works</a>
          <a href="#integrations" className="hover:text-ink">Integrations</a>
        </nav>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm"><Link href="/login">Sign in</Link></Button>
          <Button asChild size="sm"><Link href="/register">Get started</Link></Button>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 pb-20 pt-12 sm:pt-20">
        <div className="mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-cream-300 bg-cream-50 px-3.5 py-1.5 text-xs font-medium text-ink-600">
            <Sparkles className="h-3.5 w-3.5 text-accent" />
            AI Marketing Factory
          </span>
          <h1 className="mt-6 text-5xl leading-[1.04] sm:text-7xl">
            One product. One brief.
            <br />
            <span className="italic text-accent">An entire AI marketing team.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-muted">
            LaunchPilot turns what you sell into a complete, channel-ready marketing campaign. Brief it once and let
            specialised agents handle intelligence, strategy and creative.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg"><Link href="/register">Get started <ArrowRight className="h-4 w-4" /></Link></Button>
            <Button asChild size="lg" variant="outline">
              {/* PLACEHOLDER: no public demo yet; sends visitors to sign in (seeded demo account). */}
              <Link href="/login">View dashboard demo</Link>
            </Button>
            <Button asChild size="lg" variant="ghost"><Link href="/login">Sign in</Link></Button>
          </div>
        </div>

        {/* Hero visual */}
        <div className="panel-dark grain relative mx-auto mt-16 max-w-5xl overflow-hidden p-4 shadow-lift sm:p-6">
          <div className="absolute -left-20 -top-20 h-64 w-64 rounded-full bg-accent/20 blur-3xl" />
          <div className="relative grid gap-4 md:grid-cols-[1.15fr_1fr]">
            <div className="rounded-2xl bg-white/[0.06] p-5 ring-1 ring-white/10">
              <p className="mb-4 flex items-center gap-2 text-xs uppercase tracking-wider text-muted-dark">
                <FolderKanban className="h-3.5 w-3.5 text-accent" /> Projects
              </p>
              {[
                ['Deep Diving School', 'Ready', 'bg-emerald-400'],
                ['LaunchPilot Beta', 'In progress', 'bg-accent'],
                ['Cafe Aurora Spring Menu', 'Draft', 'bg-muted-dark'],
              ].map(([name, status, dot]) => (
                <div key={name} className="mb-2 flex items-center justify-between rounded-xl bg-white/[0.06] px-4 py-3 last:mb-0">
                  <span className="text-sm text-cream-100">{name}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-dark">
                    <span className={`h-1.5 w-1.5 rounded-full ${dot}`} /> {status}
                  </span>
                </div>
              ))}
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl bg-white/[0.06] p-5 ring-1 ring-white/10">
                <p className="mb-3 flex items-center gap-2 text-xs uppercase tracking-wider text-muted-dark">
                  <FileSearch className="h-3.5 w-3.5 text-accent" /> Product intake
                </p>
                <div className="space-y-2">
                  <div className="h-2.5 w-3/4 rounded-full bg-white/15" />
                  <div className="h-2.5 w-full rounded-full bg-white/10" />
                  <div className="h-2.5 w-2/3 rounded-full bg-white/10" />
                </div>
                <div className="mt-4 flex gap-1.5">
                  {['Leads', 'Cinematic', 'EN'].map((t) => (
                    <span key={t} className="rounded-full bg-accent/20 px-2.5 py-1 text-[11px] text-accent">{t}</span>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-2xl bg-white/[0.06] p-4 ring-1 ring-white/10">
                  <p className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted-dark">
                    <Plug className="h-3.5 w-3.5 text-accent" /> Linked
                  </p>
                  <p className="font-serif text-3xl text-cream-100">4</p>
                  <p className="text-xs text-muted-dark">integrations</p>
                </div>
                <div className="rounded-2xl border border-dashed border-white/20 p-4">
                  <p className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted-dark">
                    <BarChart3 className="h-3.5 w-3.5 text-accent" /> Outputs
                  </p>
                  <p className="text-sm text-cream-100">Campaigns appear here</p>
                  <p className="text-xs text-muted-dark">Coming with agents</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl px-6 py-20">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">Features</p>
        <h2 className="mt-3 max-w-2xl text-4xl sm:text-5xl">Everything a campaign needs, before the first agent runs.</h2>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="rounded-2xl border border-cream-300/80 bg-cream-50 p-6 shadow-soft transition-shadow hover:shadow-lift">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-ink text-accent">
                <f.icon className="h-5 w-5" />
              </span>
              <h3 className="mt-5 font-sans text-base font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto max-w-6xl px-6 py-20">
        <div className="panel-dark grain relative overflow-hidden p-8 sm:p-14">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">How it works</p>
          <h2 className="mt-3 max-w-xl text-4xl text-cream-100 sm:text-5xl">From idea to launch plan in three moves.</h2>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {steps.map((s) => (
              <div key={s.n} className="border-t border-white/15 pt-5">
                <p className="font-serif text-3xl text-accent">{s.n}</p>
                <h3 className="mt-3 font-sans text-lg font-semibold text-cream-100">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-dark">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Integrations + intake preview */}
      <section id="integrations" className="mx-auto grid max-w-6xl gap-6 px-6 py-20 lg:grid-cols-2">
        <div className="rounded-3xl border border-cream-300/80 bg-cream-50 p-8 shadow-soft">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">Integrations</p>
          <h2 className="mt-3 text-3xl sm:text-4xl">Plug in the tools you already use.</h2>
          <p className="mt-3 text-sm text-muted">AI providers, Google Workspace, social networks and GitHub, managed from a single page.</p>
          <div className="mt-6 flex flex-wrap gap-2">
            {integrations.map((i) => (
              <span key={i} className="rounded-full border border-cream-300 bg-cream-100 px-3.5 py-1.5 text-sm text-ink-700">{i}</span>
            ))}
          </div>
        </div>

        <div className="rounded-3xl border border-cream-300/80 bg-cream-50 p-8 shadow-soft">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">Product input flow</p>
          <h2 className="mt-3 text-3xl sm:text-4xl">A brief your agents can trust.</h2>
          <ul className="mt-6 space-y-3 text-sm">
            {['Product & assets', 'Social presence', 'Marketing goals', 'Creative preferences', 'Feature toggles', 'Review & submit'].map((s, i) => (
              <li key={s} className="flex items-center gap-3">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink text-[11px] font-semibold text-cream-100">{i + 1}</span>
                <span className="font-medium">{s}</span>
                <Check className="ml-auto h-4 w-4 text-emerald-600" />
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="relative overflow-hidden rounded-3xl bg-accent p-10 text-center text-white sm:p-16">
          <Rocket className="mx-auto h-8 w-8" />
          <h2 className="mx-auto mt-5 max-w-2xl text-4xl sm:text-5xl">Ready to brief your marketing team?</h2>
          <p className="mx-auto mt-4 max-w-lg text-white/80">Create an account, add your first product and have a launch-ready brief in minutes.</p>
          <Button asChild size="lg" variant="dark" className="mt-8"><Link href="/register">Get started free <ArrowRight className="h-4 w-4" /></Link></Button>
        </div>
      </section>

      <footer className="border-t border-cream-300/80">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-muted">
          <Logo />
          <p>© {new Date().getFullYear()} LaunchPilot. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
