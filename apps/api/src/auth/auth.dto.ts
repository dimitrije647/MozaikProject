import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsEmail() email: string;
  @IsString() @MinLength(8) @MaxLength(128) password: string;
}
export class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(1) password: string;
}
