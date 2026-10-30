import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ConfigureApiKeyDto {
  @IsString() @MinLength(1) providerKey: string;
  @IsString() @MinLength(8) @MaxLength(500) apiKey: string;
  @IsOptional() @IsString() @MaxLength(80) label?: string;
  @IsOptional() @IsBoolean() setAsDefault?: boolean;
}
export class ConnectPlaceholderDto {
  @IsString() @MinLength(1) providerKey: string;
  @IsOptional() @IsString() @MaxLength(80) displayName?: string;
}
export class DisconnectDto {
  @IsString() @MinLength(1) providerKey: string;
}
