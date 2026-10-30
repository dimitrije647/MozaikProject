import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { ProjectsModule } from '../projects/projects.module';
import { ProjectsService } from '../projects/projects.service';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';

class CreateNoteDto {
  @IsString() @MinLength(1) @MaxLength(160) title: string;
  @IsString() @MaxLength(10000) content: string;
}
class UpdateNoteDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MaxLength(10000) content?: string;
}

@Injectable()
export class WorkspaceNotesService {
  constructor(
    private prisma: PrismaService,
    private projects: ProjectsService,
  ) {}

  async list(userId: string, projectId: string) {
    await this.projects.assertOwned(userId, projectId);
    return this.prisma.workspaceNote.findMany({ where: { projectId }, orderBy: { updatedAt: 'desc' } });
  }

  async create(userId: string, projectId: string, dto: CreateNoteDto) {
    await this.projects.assertOwned(userId, projectId);
    return this.prisma.workspaceNote.create({ data: { projectId, ...dto } });
  }

  private async owned(userId: string, noteId: string) {
    const note = await this.prisma.workspaceNote.findFirst({
      where: { id: noteId, project: { userId } },
    });
    if (!note) throw new NotFoundException('Note not found');
    return note;
  }

  async update(userId: string, noteId: string, dto: UpdateNoteDto) {
    await this.owned(userId, noteId);
    return this.prisma.workspaceNote.update({ where: { id: noteId }, data: dto });
  }

  async remove(userId: string, noteId: string) {
    await this.owned(userId, noteId);
    await this.prisma.workspaceNote.delete({ where: { id: noteId } });
    return { ok: true };
  }
}

@Controller()
export class WorkspaceNotesController {
  constructor(private svc: WorkspaceNotesService) {}

  @Get('projects/:id/notes')
  list(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.list(u.id, id);
  }

  @Post('projects/:id/notes')
  create(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: CreateNoteDto) {
    return this.svc.create(u.id, id, dto);
  }

  @Patch('notes/:id')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateNoteDto) {
    return this.svc.update(u.id, id, dto);
  }

  @Delete('notes/:id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.remove(u.id, id);
  }
}

@Module({
  imports: [ProjectsModule],
  providers: [WorkspaceNotesService],
  controllers: [WorkspaceNotesController],
})
export class WorkspaceNotesModule {}
