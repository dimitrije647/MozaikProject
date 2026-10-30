import { Body, Controller, Get, HttpCode, Module, Post } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { ConfigureApiKeyDto, ConnectPlaceholderDto, DisconnectDto } from './integrations.dto';
import { ApiCredentialsModule } from '../api-credentials/api-credentials.module';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';

@Controller('integrations')
export class IntegrationsController {
  constructor(private svc: IntegrationsService) {}

  @Get('providers')
  providers() {
    return this.svc.providers();
  }

  @Get('me')
  mine(@CurrentUser() u: AuthUser) {
    return this.svc.mine(u.id);
  }

  @Post('configure-api-key')
  @HttpCode(200)
  configure(@CurrentUser() u: AuthUser, @Body() dto: ConfigureApiKeyDto) {
    return this.svc.configureApiKey(u.id, dto);
  }

  @Post('connect-placeholder')
  @HttpCode(200)
  connect(@CurrentUser() u: AuthUser, @Body() dto: ConnectPlaceholderDto) {
    return this.svc.connectPlaceholder(u.id, dto);
  }

  @Post('disconnect')
  @HttpCode(200)
  disconnect(@CurrentUser() u: AuthUser, @Body() dto: DisconnectDto) {
    return this.svc.disconnect(u.id, dto.providerKey);
  }
}

@Module({
  imports: [ApiCredentialsModule],
  providers: [IntegrationsService],
  controllers: [IntegrationsController],
})
export class IntegrationsModule {}
