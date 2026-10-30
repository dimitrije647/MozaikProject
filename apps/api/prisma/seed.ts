import { PrismaClient, ProjectStatus, IntegrationStatus, ConnectionType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { CryptoService } from '../src/common/crypto.service';
import { PROVIDER_CATALOG } from '../src/integrations/provider-catalog';

const prisma = new PrismaClient();
const crypto = new CryptoService();

const DEMO_EMAIL = 'demo@launchpilot.dev';
const DEMO_PASSWORD = 'demo12345';

async function main() {
  for (const p of PROVIDER_CATALOG) {
    await prisma.integrationProvider.upsert({ where: { key: p.key }, create: p, update: p });
  }

  // Re-seeding replaces the demo user (and everything under it via cascade).
  await prisma.user.deleteMany({ where: { email: DEMO_EMAIL } });
  const user = await prisma.user.create({
    data: {
      name: 'Demo User',
      email: DEMO_EMAIL,
      passwordHash: await bcrypt.hash(DEMO_PASSWORD, 12),
      defaultAiProvider: 'openai',
    },
  });

  // Fake key, only to show the masked/encrypted storage path. It is not a working key.
  const fakeKey = 'sk-demo-0000000000000000000000000000abcd';
  await prisma.apiCredential.create({
    data: {
      userId: user.id,
      providerKey: 'openai',
      label: 'Demo key (not real)',
      maskedKey: crypto.mask(fakeKey),
      encryptedKey: crypto.encrypt(fakeKey),
    },
  });
  await prisma.userIntegration.createMany({
    data: [
      { userId: user.id, providerKey: 'openai', status: IntegrationStatus.CONFIGURED, connectionType: ConnectionType.API_KEY, displayName: 'Demo key (not real)', maskedCredential: crypto.mask(fakeKey), connectedAt: new Date() },
      { userId: user.id, providerKey: 'github', status: IntegrationStatus.CONNECTED, connectionType: ConnectionType.PLACEHOLDER, displayName: 'demo-user (placeholder)', connectedAt: new Date() },
      { userId: user.id, providerKey: 'google_drive', status: IntegrationStatus.CONNECTED, connectionType: ConnectionType.PLACEHOLDER, displayName: 'demo@launchpilot.dev (placeholder)', connectedAt: new Date() },
      { userId: user.id, providerKey: 'meta', status: IntegrationStatus.ERROR, connectionType: ConnectionType.PLACEHOLDER, displayName: 'Token expired (sample error state)' },
    ],
  });

  const projects = [
    {
      name: 'Deep Diving School',
      slug: 'deep-diving-school',
      description: 'Certified scuba courses and guided dives for beginners and advanced divers.',
      status: ProjectStatus.READY,
      intake: {
        productName: 'Deep Diving School',
        shortDescription: 'A PADI-certified diving school offering open-water courses, advanced certifications and guided reef dives on the Adriatic coast.',
        websiteUrl: 'https://deepdivingschool.example.com',
        targetMarket: 'Croatia, Montenegro, Italy',
        targetAudience: 'Adventure-seeking adults 25-45, holiday travellers, beginner divers',
        marketingGoal: 'leads',
        preferredLanguage: 'en',
        campaignDuration: '3 months',
        stylePreference: 'cinematic',
        enableSeoAudit: true,
        enableSeasonalCalendar: true,
        enableGoogleDriveExport: true,
      },
      socials: { instagram: 'https://instagram.com/deepdivingschool', facebook: 'https://facebook.com/deepdivingschool', youtube: 'https://youtube.com/@deepdivingschool' },
      formats: ['instagram_post', 'instagram_story', 'facebook_post', 'flyer'],
      notes: [
        { title: 'Season kickoff', content: 'Open-water course bookings peak from May. Launch the campaign four weeks before.' },
        { title: 'Brand voice', content: 'Calm, adventurous, safety-first. Avoid hard-sell language.' },
      ],
    },
    {
      name: 'LaunchPilot Beta',
      slug: 'launchpilot-beta',
      description: 'Announcement campaign for the LaunchPilot public beta.',
      status: ProjectStatus.IN_PROGRESS,
      intake: {
        productName: 'LaunchPilot',
        shortDescription: 'An AI marketing factory: one brief in, a full multi-channel campaign out.',
        websiteUrl: 'https://launchpilot.example.com',
        githubUrl: 'https://github.com/example/launchpilot',
        targetMarket: 'Global',
        targetAudience: 'Founders and small marketing teams at B2B SaaS companies',
        marketingGoal: 'launch',
        preferredLanguage: 'en',
        campaignDuration: '1 month',
        stylePreference: 'minimal',
        enableSeoAudit: true,
      },
      socials: { linkedin: 'https://linkedin.com/company/launchpilot', x: 'https://x.com/launchpilot' },
      formats: ['linkedin_post', 'website_banner'],
      notes: [{ title: 'Beta waitlist', content: 'Target 500 waitlist signups before public launch.' }],
    },
    {
      name: 'Cafe Aurora Spring Menu',
      slug: 'cafe-aurora-spring-menu',
      description: 'Seasonal menu promotion for a neighbourhood cafe.',
      status: ProjectStatus.DRAFT,
      intake: {
        productName: 'Cafe Aurora',
        shortDescription: 'Specialty coffee and seasonal brunch in the old town.',
        targetMarket: 'Local, 10km radius',
        targetAudience: 'Young professionals, students, remote workers',
        marketingGoal: 'awareness',
        preferredLanguage: 'en',
        campaignDuration: '2 weeks',
        stylePreference: 'warm',
      },
      socials: { instagram: 'https://instagram.com/cafeaurora' },
      formats: ['instagram_post', 'flyer'],
      notes: [],
    },
  ];

  for (const p of projects) {
    const project = await prisma.project.create({
      data: { userId: user.id, name: p.name, slug: p.slug, description: p.description, status: p.status },
    });
    await prisma.productIntake.create({ data: { projectId: project.id, ...p.intake } });
    await prisma.socialProfile.createMany({
      data: Object.entries(p.socials).map(([platform, url]) => ({ projectId: project.id, platform, url })),
    });
    await prisma.campaignFormatPreference.createMany({
      data: p.formats.map((formatType) => ({ projectId: project.id, formatType, enabled: true })),
    });
    if (p.notes.length) {
      await prisma.workspaceNote.createMany({ data: p.notes.map((n) => ({ projectId: project.id, ...n })) });
    }
    await prisma.activityLog.create({
      data: { userId: user.id, projectId: project.id, eventType: 'project.created', eventDataJson: { name: p.name } },
    });
  }

  console.log(`Seeded demo user: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
