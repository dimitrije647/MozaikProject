import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, MaxLength, MinLength, ValidateIf } from 'class-validator';

const url = { require_protocol: true, protocols: ['http', 'https'] };

export class UpsertIntakeDto {
  @IsString() @MinLength(2) @MaxLength(120) productName: string;
  @IsOptional() @IsString() @MaxLength(2000) shortDescription?: string;
  @ValidateIf((o) => Boolean(o.websiteUrl)) @IsUrl(url) websiteUrl?: string;
  @ValidateIf((o) => Boolean(o.githubUrl)) @IsUrl(url) githubUrl?: string;
  @IsOptional() @IsString() @MaxLength(200) targetMarket?: string;
  @IsOptional() @IsString() @MaxLength(1000) targetAudience?: string;
  @IsOptional() @IsString() @MaxLength(100) marketingGoal?: string;
  @IsOptional() @IsString() @MaxLength(20) preferredLanguage?: string;
  @IsOptional() @IsString() @MaxLength(50) campaignDuration?: string;
  @IsOptional() @IsString() @MaxLength(100) stylePreference?: string;
  @IsOptional() @IsIn(['manual', 'scheduled']) publishingMode?: string;
  @IsOptional() @IsBoolean() enableSeoAudit?: boolean;
  @IsOptional() @IsBoolean() enableSeasonalCalendar?: boolean;
  @IsOptional() @IsBoolean() enableGoogleDriveExport?: boolean;
}
