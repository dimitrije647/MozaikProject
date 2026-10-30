import type { ProjectStatus } from './types';

export const SOCIAL_PLATFORMS = [
  { key: 'instagram', label: 'Instagram', placeholder: 'https://instagram.com/yourbrand' },
  { key: 'facebook', label: 'Facebook', placeholder: 'https://facebook.com/yourbrand' },
  { key: 'linkedin', label: 'LinkedIn', placeholder: 'https://linkedin.com/company/yourbrand' },
  { key: 'x', label: 'X', placeholder: 'https://x.com/yourbrand' },
  { key: 'reddit', label: 'Reddit', placeholder: 'https://reddit.com/r/yourbrand' },
  { key: 'tiktok', label: 'TikTok', placeholder: 'https://tiktok.com/@yourbrand' },
  { key: 'pinterest', label: 'Pinterest', placeholder: 'https://pinterest.com/yourbrand' },
  { key: 'youtube', label: 'YouTube', placeholder: 'https://youtube.com/@yourbrand' },
] as const;

export const MARKETING_GOALS = [
  { value: 'leads', label: 'Generate leads' },
  { value: 'awareness', label: 'Build awareness' },
  { value: 'launch', label: 'Product launch' },
  { value: 'sales', label: 'Drive sales' },
  { value: 'engagement', label: 'Grow engagement' },
  { value: 'retention', label: 'Retain customers' },
];

export const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'sr', label: 'Serbian' },
  { value: 'hr', label: 'Croatian' },
  { value: 'de', label: 'German' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'it', label: 'Italian' },
];

export const DURATIONS = ['2 weeks', '1 month', '3 months', '6 months', 'Ongoing'];

export const STYLES = [
  { value: 'minimal', label: 'Minimal', hint: 'Clean, airy, restrained' },
  { value: 'bold', label: 'Bold', hint: 'High contrast, loud type' },
  { value: 'cinematic', label: 'Cinematic', hint: 'Moody, photographic' },
  { value: 'playful', label: 'Playful', hint: 'Colourful, friendly' },
  { value: 'warm', label: 'Warm', hint: 'Earthy, human, inviting' },
  { value: 'corporate', label: 'Corporate', hint: 'Trusted, professional' },
];

export const FORMAT_OPTIONS = [
  { key: 'instagram_post', label: 'Instagram post' },
  { key: 'instagram_story', label: 'Instagram story' },
  { key: 'facebook_post', label: 'Facebook post' },
  { key: 'linkedin_post', label: 'LinkedIn post' },
  { key: 'website_banner', label: 'Website banner' },
  { key: 'billboard', label: 'Billboard' },
  { key: 'flyer', label: 'Flyer' },
  { key: 'other', label: 'Other' },
] as const;

export const PROJECT_STATUS: Record<ProjectStatus, { label: string; className: string }> = {
  DRAFT: { label: 'Draft', className: 'bg-cream-200 text-ink-600' },
  READY: { label: 'Ready', className: 'bg-emerald-100 text-emerald-800' },
  IN_PROGRESS: { label: 'In progress', className: 'bg-accent-soft text-accent-hover' },
  COMPLETED: { label: 'Completed', className: 'bg-ink text-cream-100' },
  ARCHIVED: { label: 'Archived', className: 'bg-cream-300 text-muted' },
};

export const ASSET_KINDS = [
  { value: 'logo', label: 'Logo' },
  { value: 'screenshot', label: 'Product screenshots' },
  { value: 'image', label: 'Images' },
  { value: 'pdf', label: 'PDFs / docs' },
  { value: 'reference', label: 'Brand references' },
] as const;
