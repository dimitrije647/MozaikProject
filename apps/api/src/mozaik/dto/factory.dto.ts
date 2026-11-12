import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUrl, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { HybridSettingsDto } from './hybrid.dto';

export const SOCIAL_CHANNEL_IDS = ['x', 'tiktok', 'facebook', 'instagram', 'linkedin'] as const;
export const VOICE_TONE_IDS = ['professional', 'conversational', 'playful', 'premium', 'technical'] as const;

/** The writing style of this campaign. Every field is optional: without it the brand voice is inferred from the project's research. */
export class CampaignVoiceDto {
  @IsOptional() @IsIn([...VOICE_TONE_IDS]) tone?: string;
  /** false = no humor; true = light humor where it fits (never in a regulated industry). */
  @IsOptional() @IsBoolean() humor?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(60, { each: true }) preferredTerms?: string[];
  /** Words, expressions or claims the copy must never use. */
  @IsOptional() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(80, { each: true }) avoid?: string[];
}

/**
 * "Generate Campaign": the ONE production workflow (Business Research -> Marketing Strategy -> Creative Production). Every field is optional:
 * objective, audience and the seasonal calendar default to the project's own information, the channels to all five social platforms. The text
 * provider and model are the defaults saved under Settings > AI providers. There is no preset, no mode and no image model: no AI image is ever made.
 */
export class StartFactoryDto {
  /** The campaign objective. Default: the project's marketing goal. */
  @IsOptional() @IsString() @MaxLength(300) objective?: string;
  /** Who the campaign speaks to. Default: the project's target audience. */
  @IsOptional() @IsString() @MaxLength(300) targetAudience?: string;
  /** Social platforms to produce for (default: all five). Web/display ads, billboards and flyers come from the campaign design. */
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsIn([...SOCIAL_CHANNEL_IDS], { each: true }) channels?: string[];
  /** Campaign concepts (1-5). Default 3. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) concepts?: number;
  /** Competitor websites you know of (read first, never invented). */
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { each: true }) @MaxLength(300, { each: true }) competitorUrls?: string[];
  /** Ask the free public-holiday calendar. Default: the project's "seasonal calendar" setting. */
  @IsOptional() @IsBoolean() useHolidayCalendar?: boolean;
  /** Run Business Research again even when the project's research is current. */
  @IsOptional() @IsBoolean() refreshResearch?: boolean;
  /** The writing style (tone, humor, preferred and forbidden words). Default: inferred from the project's research and strategy. */
  @IsOptional() @ValidateNested() @Type(() => CampaignVoiceDto) voice?: CampaignVoiceDto;
  /** The visual design: template collection, palette, print/ad formats, picture sourcing, facts and references. */
  @IsOptional() @ValidateNested() @Type(() => HybridSettingsDto) design?: HybridSettingsDto;
  /**
   * The ONE campaign budget in US dollars for every paid request (all text-model calls of all stages). Required with `confirmCost` to START.
   * LaunchPilot enforces it before every request; it is an application-side limit, not a provider billing cap.
   */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(500) approvedBudgetUsd?: number;
  /** The user has seen the cost estimate and agrees to the paid requests of exactly this plan. */
  @IsOptional() @IsBoolean() confirmCost?: boolean;
}
