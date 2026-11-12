import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * V4: the stages of a campaign (Business Research, Marketing Strategy, Creative Production) are started ONLY by Campaign Production
 * (POST /projects/:id/factory). There is no separate start request per stage any more; the DTOs below are for reading saved results.
 */

export class StartSmokeTestDto {
  /** Optional delay before the test participant answers (lets you watch it run, or cancel it). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) delayMs?: number;
}

export class ListEventsQueryDto {
  /** Cursor: return events with a sequence greater than this. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) afterSequence?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

/** Cursor pagination of saved results (research reports, historical audits, strategies, campaigns). */
export class ListAuditsQueryDto {
  @IsOptional() @IsString() @MaxLength(60) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}
