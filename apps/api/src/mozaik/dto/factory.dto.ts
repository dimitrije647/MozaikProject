import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { CHANNELS, MODEL_ID } from './mozaik.dto';
import { HybridSettingsDto } from './hybrid.dto';

/** The exact saved results to build on (optional). They must form ONE coherent chain, or the request is refused. */
export class FactoryReportsDto {
  @IsOptional() @IsString() @MaxLength(60) f1ReportId?: string;
  @IsOptional() @IsString() @MaxLength(60) f2AuditId?: string;
  @IsOptional() @IsString() @MaxLength(60) f3StrategyId?: string;
}

export class FactoryDiscoveryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(3) @Max(40) maxModelCalls?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(8) maxReviews?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(800) @Max(16000) maxOutputTokens?: number;
}

export class FactoryAuditDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(3) @Max(30) maxModelCalls?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(8) maxReviews?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(800) @Max(16000) maxOutputTokens?: number;
}

export class FactoryStrategyDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(6) @Max(40) maxModelCalls?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(6) maxScouts?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) maxReviews?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(800) @Max(16000) maxOutputTokens?: number;
  @IsOptional() @IsBoolean() useHolidayCalendar?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { each: true }) @MaxLength(300, { each: true }) competitorUrls?: string[];
  @IsOptional() @IsString() @MaxLength(300) goal?: string;
  @IsOptional() @IsString() @MaxLength(200) budgetNote?: string;
}

export class FactoryCreativeDto {
  /** A GPT Image model id, or null for no image generation (brand-colored backgrounds). */
  @IsOptional() @ValidateIf((o) => o.imageModel !== null && o.imageModel !== undefined) @IsString() @Matches(/^(auto|gpt-image-[A-Za-z0-9._-]{1,40})$/, { message: 'imageModel must be "auto" or a GPT Image model id (gpt-image-*)' }) imageModel?: string | null;
  @IsOptional() @IsIn(['low', 'medium', 'high', 'xhigh', 'max', 'auto']) imageQuality?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  /** How auto picks the image model: economy (cheapest try-out), balanced, or quality (the most capable current model). An explicit imageModel ignores it. */
  @IsOptional() @IsIn(['economy', 'balanced', 'quality']) imageModelStrategy?: 'economy' | 'balanced' | 'quality';
  @IsOptional() @IsIn(['1024x1024', '1024x1536', '1536x1024']) imageSize?: '1024x1024' | '1024x1536' | '1536x1024';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) concepts?: number;
  /** Channels to produce for; null/omitted = the strategy's recommended channels (up to 4). */
  @IsOptional() @IsArray() @ArrayMaxSize(9) @IsIn(CHANNELS, { each: true }) channels?: string[] | null;
  @IsOptional() @IsBoolean() landing?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(40) maxImages?: number;
  /** Several original images per concept (Full Production). With it, maxImages is the number of originals and is not tied to the concept count. */
  @IsOptional() @IsBoolean() variations?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(6) layoutsPerOriginal?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(4) imageConcurrency?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(6) @Max(30) maxVariants?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(5) maxRegenerations?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(6) maxLayoutsPerConcept?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3) maxRepairRounds?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(6) visionReviews?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(4) @Max(80) maxModelCalls?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(800) @Max(16000) maxOutputTokens?: number;
}

/**
 * One-click full campaign (F1 -> F2 -> F3 -> F4). Every field is optional: the preset supplies conservative defaults, and
 * every limit is enforced by LaunchPilot per phase (not an OpenAI spending cap).
 */
export class StartFactoryDto {
  /** first_test = lowest cost (default); demo = richer output, still bounded; full_production = 20 original AI images; hybrid_production = a few original AI images plus template creatives rendered locally. */
  @IsOptional() @IsIn(['first_test', 'demo', 'full_production', 'hybrid_production', 'no_ai_hybrid']) preset?: 'first_test' | 'demo' | 'full_production' | 'hybrid_production' | 'no_ai_hybrid';
  /** continue = reuse a compatible chain of saved results (default); fresh = run every phase again. */
  @IsOptional() @IsIn(['continue', 'fresh']) mode?: 'continue' | 'fresh';
  /** Produce a new creative round even when a campaign already exists for the reused strategy. */
  @IsOptional() @IsBoolean() rerunCreative?: boolean;
  /** Reuse saved reports that are flagged partial (default true; the plan says so). */
  @IsOptional() @IsBoolean() reusePartial?: boolean;
  /**
   * The ONE campaign budget in US dollars the user approves for the whole run: every text call, every image, every review and repair draws
   * on this single total. Required, together with `confirmCost`, to START Full Production and Hybrid Production (and any plan whose image
   * price is unknown); optional for First Test and Demo. LaunchPilot enforces it before every paid request, but it is an
   * application-side limit, not an OpenAI billing cap.
   */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(500) approvedBudgetUsd?: number;
  /** The user has seen the cost breakdown and agrees to the paid requests of exactly this plan. */
  @IsOptional() @IsBoolean() confirmCost?: boolean;
  /** DEPRECATED and ignored: there is no separate unknown-price checkbox any more. Use approvedImageRequests inside the one budget approval. Accepted so older clients still validate. */
  @IsOptional() @IsBoolean() confirmUnpricedImages?: boolean;
  /**
   * The MAXIMUM number of image requests approved together with the budget and confirmCost. Required when the image price is not published; it must
   * equal the cap the plan showed (computed from the plan, never typed). The run never sends more image requests than this.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(40) approvedImageRequests?: number;
  /** DEPRECATED and ignored: there is ONE campaign budget (approvedBudgetUsd) shared by text, images and reviews. Accepted so older clients still validate. */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(500) textBudgetUsd?: number;
  /** Deeper work: more cross-check passes in F1-F3 and a concept critique before the images in F4 (Full Production default on). */
  @IsOptional() @IsBoolean() depth?: boolean;
  /** Text model override for every phase. Default: the model saved in Settings (never switched silently). */
  @IsOptional() @IsString() @Matches(MODEL_ID, { message: 'model must be a valid OpenAI model id' }) model?: string;
  @IsOptional() @ValidateNested() @Type(() => FactoryReportsDto) reports?: FactoryReportsDto;
  @IsOptional() @ValidateNested() @Type(() => FactoryDiscoveryDto) f1?: FactoryDiscoveryDto;
  @IsOptional() @ValidateNested() @Type(() => FactoryAuditDto) f2?: FactoryAuditDto;
  @IsOptional() @ValidateNested() @Type(() => FactoryStrategyDto) f3?: FactoryStrategyDto;
  @IsOptional() @ValidateNested() @Type(() => FactoryCreativeDto) f4?: FactoryCreativeDto;
  /** Hybrid Production settings (only used with preset hybrid_production). */
  @IsOptional() @ValidateNested() @Type(() => HybridSettingsDto) hybrid?: HybridSettingsDto;
}

/** Generate ONLY the missing original images of a finished campaign (billed by OpenAI: needs an approved limit and a confirmation). */
export class ContinueImagesDto {
  /** Text model for the (small) review of the new images. Default: the model the campaign was made with. */
  @IsOptional() @IsString() @Matches(MODEL_ID, { message: 'model must be a valid OpenAI model id' }) model?: string;
  /** Default: the image model of the earlier campaign (a retired model is refused). "auto" picks a current one from your key. */
  @IsOptional() @IsString() @Matches(/^(auto|gpt-image-[A-Za-z0-9._-]{1,40})$/, { message: 'imageModel must be "auto" or a GPT Image model id (gpt-image-*)' }) imageModel?: string;
  @IsOptional() @IsIn(['low', 'medium', 'high', 'xhigh', 'max', 'auto']) imageQuality?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  /** At most this many missing images are requested now (default: all that are missing). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(40) maxImages?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(6) visionReviews?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(500) approvedBudgetUsd?: number;
  @IsOptional() @IsBoolean() confirmCost?: boolean;
  /** DEPRECATED and ignored: use approvedImageRequests inside the one budget approval. */
  @IsOptional() @IsBoolean() confirmUnpricedImages?: boolean;
  /** The maximum number of image requests approved with the budget (the number the review showed). Required when the image price is not published. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(40) approvedImageRequests?: number;
}
