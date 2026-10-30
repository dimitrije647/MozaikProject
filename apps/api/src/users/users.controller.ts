import { Body, Controller, Get, Patch } from '@nestjs/common';
import { UsersService } from './users.service';
import { ChangePasswordDto, UpdateProfileDto } from './users.dto';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';

@Controller('users/me')
export class UsersController {
  constructor(private users: UsersService) {}

  @Get()
  get(@CurrentUser() u: AuthUser) {
    return this.users.getProfile(u.id);
  }

  @Patch()
  update(@CurrentUser() u: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(u.id, dto);
  }

  @Patch('password')
  password(@CurrentUser() u: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.users.changePassword(u.id, dto);
  }
}
