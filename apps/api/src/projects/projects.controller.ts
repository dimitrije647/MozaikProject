import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { CreateProjectDto, UpdateProjectDto } from './projects.dto';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';

@Controller('projects')
export class ProjectsController {
  constructor(private projects: ProjectsService) {}

  @Get() list(@CurrentUser() u: AuthUser) {
    return this.projects.list(u.id);
  }
  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(u.id, dto);
  }
  @Get(':id') get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.projects.get(u.id, id);
  }
  @Patch(':id') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateProjectDto) {
    return this.projects.update(u.id, id, dto);
  }
  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.projects.remove(u.id, id);
  }
}
