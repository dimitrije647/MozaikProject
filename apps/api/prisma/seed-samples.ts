import { PrismaClient, ProjectStatus } from '@prisma/client';

/**
 * Adds extra SAMPLE projects for the demo user to try Product Discovery on very different kinds of
 * business. It is purely additive and idempotent: it never deletes or modifies existing users,
 * projects or data, and skips a sample that already exists (matched by slug).
 *
 *   pnpm --filter @launchpilot/api db:seed:samples
 */
const prisma = new PrismaClient();
const DEMO_EMAIL = 'demo@launchpilot.dev';

const samples = [
  {
    name: 'TaskFlow (software sample)',
    slug: 'taskflow-software-sample',
    description: 'A project management web app for small remote teams.',
    intake: {
      productName: 'TaskFlow',
      shortDescription:
        'TaskFlow is a web application for small remote teams (5 to 30 people). Teams create projects, split them into tasks, assign owners and deadlines, and follow progress on a shared board. ' +
        'It sends a short daily summary by email and integrates with Slack. We are still building the first version and have no paying customers yet.',
      targetMarket: 'Europe, English-speaking remote teams',
      targetAudience: 'Team leads and founders at small software and design agencies',
      marketingGoal: 'leads',
      preferredLanguage: 'en',
      campaignDuration: '3 months',
      stylePreference: 'minimal',
    },
    notes: [
      { title: 'Pricing idea', content: 'Thinking about a free plan for up to 3 projects and a paid plan per user per month. Not decided.' },
      { title: 'Open questions', content: 'Unsure whether to focus on agencies or internal product teams.' },
    ],
  },
];

async function main() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (!user) {
    console.log(`No ${DEMO_EMAIL} user found. Run "pnpm db:seed" first, or create the sample projects manually.`);
    return;
  }
  for (const s of samples) {
    const exists = await prisma.project.findUnique({ where: { userId_slug: { userId: user.id, slug: s.slug } } });
    if (exists) {
      console.log(`Sample "${s.name}" already exists. Left untouched.`);
      continue;
    }
    const project = await prisma.project.create({
      data: { userId: user.id, name: s.name, slug: s.slug, description: s.description, status: ProjectStatus.READY },
    });
    await prisma.productIntake.create({ data: { projectId: project.id, ...s.intake } });
    await prisma.workspaceNote.createMany({ data: s.notes.map((n) => ({ projectId: project.id, ...n })) });
    console.log(`Created sample project "${s.name}".`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
