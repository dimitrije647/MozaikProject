import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PERMISSION_STATUS, REFERENCE_KINDS, STYLE_IDS } from '@launchpilot/agents';

/** Facts only the user can supply (an offer, a date, a quote...). A template that needs one is not used without it: nothing is invented. */
export class HybridFactsDto {
  @IsOptional() @IsString() @MaxLength(20) offer?: string;
  @IsOptional() @IsString() @MaxLength(60) offerDetail?: string;
  @IsOptional() @IsString() @MaxLength(30) date?: string;
  @IsOptional() @IsString() @MaxLength(40) location?: string;
  @IsOptional() @IsString() @MaxLength(160) quote?: string;
  @IsOptional() @IsString() @MaxLength(60) attribution?: string;
  @IsOptional() @IsString() @MaxLength(12) stat?: string;
  @IsOptional() @IsString() @MaxLength(50) statLabel?: string;
  @IsOptional() @IsString() @MaxLength(30) tag?: string;
}

/** A reference the user attached. The server decides what each kind may do (links and Pinterest are link-only); the permission sent here is not trusted. */
export class HybridReferenceDto {
  @IsString() @MaxLength(60) id!: string;
  @IsIn([...REFERENCE_KINDS]) kind!: (typeof REFERENCE_KINDS)[number];
  @IsOptional() @IsString() @MaxLength(120) label?: string;
  @IsOptional() @IsUrl({ protocols: ['http', 'https'], require_protocol: true }) @MaxLength(300) url?: string;
  @IsOptional() @IsIn([...PERMISSION_STATUS]) permission?: (typeof PERMISSION_STATUS)[number];
}

/** Image sourcing of a campaign. `generation: "forbidden"` is NO AI HYBRID: no image-generation request is ever made. */
export class HybridImageryDto {
  @IsOptional() @IsIn(['allowed', 'forbidden']) generation?: 'allowed' | 'forbidden';
  @IsOptional() @IsBoolean() autoStock?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3) maxSourcesPerConcept?: number;
  @IsOptional() @IsBoolean() allowPaidSearch?: boolean;
}

export class HybridSettingsDto {
  /** Original AI images (one provider request each). Default 5. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(40) originals?: number;
  /** Template creatives rendered locally from the originals and the brand assets. Default 15. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(60) templateCreatives?: number;
  /** LEGACY (ignored when a design is sent): the visual style used to be chosen here. The campaign design below is the one visual choice. */
  @IsOptional() @IsIn(['auto', ...STYLE_IDS]) style?: string;
  /** The approved campaign design (collection, palette, formats, picture sourcing). Validated in full by the agents package; an invalid one is refused, never repaired. */
  @IsOptional() @IsObject() design?: Record<string, unknown>;
  @IsOptional() @IsIn(['automatic', 'assisted', 'manual']) selection?: 'automatic' | 'assisted' | 'manual';
  /** slotId -> templateId (validated against the library, the slot's format and its content by the server). */
  @IsOptional() @IsObject() overrides?: Record<string, string>;
  @IsOptional() @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) @Matches(/^[a-z0-9][a-z0-9_]{2,48}$/, { each: true }) preferredTemplates?: string[];
  @IsOptional() @IsBoolean() allowTemplateFallback?: boolean;
  @IsOptional() @IsBoolean() directionRefine?: boolean;
  @IsOptional() @IsBoolean() reviewDirection?: boolean;
  @IsOptional() @IsBoolean() directionApproved?: boolean;
  @IsOptional() @IsIn(['style_library', 'brand_assets', 'references']) inspiration?: 'style_library' | 'brand_assets' | 'references';
  @IsOptional() @IsArray() @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => HybridReferenceDto) references?: HybridReferenceDto[];
  @IsOptional() @ValidateNested() @Type(() => HybridFactsDto) facts?: HybridFactsDto;
  @IsOptional() @ValidateNested() @Type(() => HybridImageryDto) imagery?: HybridImageryDto;
}
