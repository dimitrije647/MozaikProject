import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class ConnectPinterestDto {
  /** In-app page to return to after authorizing, e.g. "/projects/abc/campaign". Anything else is ignored. */
  @IsOptional() @IsString() @MaxLength(200) returnPath?: string;
}

export class PinterestPageQueryDto {
  /** Opaque cursor returned by the previous page. */
  @IsOptional() @IsString() @MaxLength(1024) @Matches(/^\S+$/, { message: 'bookmark must not contain whitespace' }) bookmark?: string;
}
