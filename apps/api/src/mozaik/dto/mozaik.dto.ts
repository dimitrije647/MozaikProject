import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class StartSmokeTestDto {
  /** Optional delay before the test participant answers (lets you watch it run, or cancel it). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) delayMs?: number;
}

export class StartDiscoveryDto {
  /** Overrides the model saved in Settings for this run only. Validated, never defaulted. */
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/, { message: 'model must be a valid OpenAI model id' }) model?: string;
  /** Per-run cap on provider calls (retries and repair attempts count). Default 6. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(3) @Max(12) maxModelCalls?: number;
  /** max_output_tokens per call. Default 3500. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(800) @Max(8000) maxOutputTokens?: number;
}

export class ListEventsQueryDto {
  /** Cursor: return events with a sequence greater than this. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) afterSequence?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}
