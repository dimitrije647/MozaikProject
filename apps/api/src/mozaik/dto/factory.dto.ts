import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { CHANNELS, MODEL_ID } from './mozaik.dto';

/** The exact saved results to build on (optional). They must form ONE coherent chain, or the request is refused. */
export class FactoryReportsDto {
  @IsOptional() @IsString() @MaxLength(60) f1ReportId?: string;
  @IsOptional() @IsString() @MaxLength(60) f2AuditId?: string;
  @IsOptional() @IsString() @MaxLength(60) f3StrategyId?: string;
}

export class FactoryDiscoveryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(3) @Max(40) maxModelCalls?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(8) maxReviews?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(800) @Max(8000) maxOutputTokens?: number;
}

export class FactoryAuditDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(3) @Max(30) maxModelCalls?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(8) maxReviews?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(800) @Max(6000) maxOutputTokens?: number;
}

export class FactoryStrategyDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(6) @Max(40) maxModelCalls?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(6) maxScouts?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) maxReviews?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(800) @Max(6000) maxOutputTokens?: number;
  @IsOptional() @IsBoolean() useHolidayCalendar?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { each: true }) @MaxLength(300, { each: true }) competitorUrls?: string[];
  @IsOptional() @IsString() @MaxLength(300) goal?: string;
  @IsOptional() @IsString() @MaxLength(200) budgetNote?: string;
}

export class FactoryCreativeDto {
  /** A GPT Image model id, or null for no image generation (brand-colored backgrounds). */
  @IsOptional() @ValidateIf((o) => o.imageModel !== null && o.imageModel !== undefined) @IsString() @Matches(/^(auto|gpt-image-[A-Za-z0-9._-]{1,40})$/, { message: 'imageModel must be "auto" or a GPT Image model id (gpt-image-*)' }) imageModel?: string | null;
  @IsOptional() @IsIn(['low', 'medium', 'high', 'auto']) imageQuality?: 'low' | 'medium' | 'high' | 'auto';
  @IsOptional() @IsIn(['1024x1024', '1024x1536', '1536x1024']) imageSize?: '1024x1024' | '1024x1536' | '1536x1024';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) concepts?: number;
  /** Channels to produce for; null/omitted = the strategy's recommended channels (up to 4). */
  @IsOptional() @IsArray() @ArrayMaxSize(9) @IsIn(CHANNELS, { each: true }) channels?: string[] | null;
  @IsOptional() @IsBoolean() landing?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) maxImages?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(5) maxRegenerations?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(6) maxLayoutsPerConcept?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3) maxRepairRounds?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(6) visionReviews?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(4) @Max(40) maxModelCalls?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(800) @Max(6000) maxOutputTokens?: number;
}

/**
 * One-click full campaign (F1 -> F2 -> F3 -> F4). Every field is optional: the preset supplies conservative defaults, and
 * every limit is enforced by LaunchPilot per phase (not an OpenAI spending cap).
 */
export class StartFactoryDto {
  /** first_test = lowest cost (default); demo = richer output, still bounded. */
  @IsOptional() @IsIn(['first_test', 'demo']) preset?: 'first_test' | 'demo';
  /** continue = reuse a compatible chain of saved results (default); fresh = run every phase again. */
  @IsOptional() @IsIn(['continue', 'fresh']) mode?: 'continue' | 'fresh';
  /** Produce a new creative round even when a campaign already exists for the reused strategy. */
  @IsOptional() @IsBoolean() rerunCreative?: boolean;
  /** Reuse saved reports that are flagged partial (default true; the plan says so). */
  @IsOptional() @IsBoolean() reusePartial?: boolean;
  /** Text model override for every phase. Default: the model saved in Settings (never switched silently). */
  @IsOptional() @IsString() @Matches(MODEL_ID, { message: 'model must be a valid OpenAI model id' }) model?: string;
  @IsOptional() @ValidateNested() @Type(() => FactoryReportsDto) reports?: FactoryReportsDto;
  @IsOptional() @ValidateNested() @Type(() => FactoryDiscoveryDto) f1?: FactoryDiscoveryDto;
  @IsOptional() @ValidateNested() @Type(() => FactoryAuditDto) f2?: FactoryAuditDto;
  @IsOptional() @ValidateNested() @Type(() => FactoryStrategyDto) f3?: FactoryStrategyDto;
  @IsOptional() @ValidateNested() @Type(() => FactoryCreativeDto) f4?: FactoryCreativeDto;
}
