import { Body, Controller, Get, HttpCode, Module, Post, Put } from '@nestjs/common';
import { IsOptional, IsString, Matches } from 'class-validator';
import { ApiCredentialsModule } from '../api-credentials/api-credentials.module';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { OpenAiService } from './openai.service';

/** Model ids look like "gpt-4o-mini", "o3", "ft:gpt-4o:org::id". No whitespace or odd characters. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/;

class SetModelDto {
  @IsString() @Matches(MODEL_ID_PATTERN, { message: 'model must be a valid OpenAI model id' }) model: string;
}
class TestConnectionDto {
  @IsOptional() @IsString() @Matches(MODEL_ID_PATTERN, { message: 'model must be a valid OpenAI model id' }) model?: string;
}

@Controller('integrations/openai')
export class OpenAiController {
  constructor(private svc: OpenAiService) {}

  @Get('status')
  status(@CurrentUser() u: AuthUser) {
    return this.svc.status(u.id);
  }

  /** Free: lists the models this key can see. Never selects one. */
  @Get('models')
  models(@CurrentUser() u: AuthUser) {
    return this.svc.listModels(u.id);
  }

  @Put('model')
  setModel(@CurrentUser() u: AuthUser, @Body() dto: SetModelDto) {
    return this.svc.setModel(u.id, dto.model);
  }

  /** Makes ONE tiny paid inference call, only when explicitly requested. */
  @Post('test')
  @HttpCode(200)
  test(@CurrentUser() u: AuthUser, @Body() dto: TestConnectionDto) {
    return this.svc.testConnection(u.id, dto.model);
  }
}

@Module({
  imports: [ApiCredentialsModule],
  providers: [OpenAiService],
  controllers: [OpenAiController],
})
export class OpenAiModule {}
