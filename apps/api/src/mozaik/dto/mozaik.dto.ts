import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class StartSmokeTestDto {
  /** Optional delay before the test participant answers (lets you watch it run, or cancel it). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) delayMs?: number;
}

export class StartDiscoveryDto {
  /** Overrides the model saved in Settings for this run only. Validated, never defaulted. */
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/, { message: 'model must be a valid OpenAI model id' }) model?: string;
  /** Per-run cap on provider calls (analysts, cross-checks, retries and repairs all count). Default 16. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(3) @Max(40) maxModelCalls?: number;
  /** Maximum cross-check reviews (each costs one call). Default 4, 0 disables them. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(8) maxReviews?: number;
  /** max_output_tokens per call. Default 3000 for analysts. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(800) @Max(8000) maxOutputTokens?: number;
}

export class ListEventsQueryDto {
  /** Cursor: return events with a sequence greater than this. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) afterSequence?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

/** Profile details the user types in for the Social Media Auditor. Treated as user-provided, never verified. */
export class SocialDetailsDto {
  @IsIn(['instagram', 'facebook', 'linkedin', 'x', 'twitter', 'youtube', 'tiktok', 'pinterest', 'reddit']) platform!: string;
  @IsOptional() @IsString() @MaxLength(300) url?: string;
  @IsOptional() @IsString() @MaxLength(600) bio?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000_000) followers?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1000) postsPerMonth?: number;
  @IsOptional() @IsString() @MaxLength(600) notes?: string;
}

export class StartAuditDto {
  /** Overrides the model saved in Settings for this run only. */
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/, { message: 'model must be a valid OpenAI model id' }) model?: string;
  /** The completed F1 report to build on. Defaults to the newest completed one. */
  @IsOptional() @IsString() @MaxLength(60) f1ReportId?: string;
  /** Per-run cap on provider calls. Default 14. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(3) @Max(30) maxModelCalls?: number;
  /** Maximum cross-check reviews. Default 4, 0 disables them. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(8) maxReviews?: number;
  /** max_output_tokens per auditor call. Default 2500. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(800) @Max(6000) maxOutputTokens?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(8) @ValidateNested({ each: true }) @Type(() => SocialDetailsDto) socialDetails?: SocialDetailsDto[];
}

export class ListAuditsQueryDto {
  @IsOptional() @IsString() @MaxLength(60) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}

export class StartStrategyDto {
  /** Overrides the model saved in Settings for this run only. */
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/, { message: 'model must be a valid OpenAI model id' }) model?: string;
  /** The completed F2 audit to build on (its F1 report is resolved from it). Defaults to the newest completed audit. */
  @IsOptional() @IsString() @MaxLength(60) auditId?: string;
  /** Per-run cap on provider calls (researchers, scouts, reviews, repairs, strategist). Default 24. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(6) @Max(40) maxModelCalls?: number;
  /** Maximum dynamically created Channel Scouts. Default 4. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(6) maxScouts?: number;
  /** Maximum cross-check reviews. Default 6, 0 disables them. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) maxReviews?: number;
  /** max_output_tokens per researcher/scout call. Default 2500. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(800) @Max(6000) maxOutputTokens?: number;
  /** Competitor websites you know of (analyzed first, never invented). */
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { each: true }) @MaxLength(300, { each: true }) competitorUrls?: string[];
  /** The campaign goal for this strategy; defaults to the intake's marketing goal. */
  @IsOptional() @IsString() @MaxLength(300) goal?: string;
  @IsOptional() @IsString() @MaxLength(200) budgetNote?: string;
  /** Ask the free public-holiday calendar (default: the intake's "seasonal calendar" setting). */
  @IsOptional() @IsBoolean() useHolidayCalendar?: boolean;
}
