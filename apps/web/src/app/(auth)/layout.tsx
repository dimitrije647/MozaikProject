import Link from 'next/link';
import { Logo } from '@/components/logo';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <div className="flex flex-col px-6 py-8 sm:px-12">
        <Logo />
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">{children}</div>
        <p className="text-xs text-muted">
          <Link href="/" className="hover:text-ink">
            ← Back to home
          </Link>
        </p>
      </div>

      <div className="relative hidden p-4 lg:block">
        <div className="panel-dark grain relative flex h-full flex-col justify-between overflow-hidden p-12">
          <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-accent/25 blur-3xl" />
          <p className="relative text-xs font-medium uppercase tracking-[0.18em] text-accent">AI Marketing Factory</p>
          <div className="relative">
            <h2 className="font-serif text-5xl leading-[1.05] text-cream-100">
              One product.
              <br />
              One brief.
              <br />
              <span className="italic text-accent">An entire team.</span>
            </h2>
            <p className="mt-6 max-w-sm text-[15px] leading-relaxed text-muted-dark">
              Describe what you sell once. LaunchPilot turns it into a structured brief that your AI marketing
              agents can run with.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
