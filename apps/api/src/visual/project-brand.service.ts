import { Injectable } from '@nestjs/common';
import { exportEligibility, type BrandContext, type ImageRights } from '@launchpilot/agents';
import { PrismaService } from '../common/prisma.service';

/**
 * THE PROJECT'S BRAND CONTENT: which logo is the company's approved logo, and whether the owner approved brand material with Get Content at all.
 *
 * `logoAsset` is the ONE place that decides which logo every part of the product uses (the campaign run, the free preview, the brand analysis, the
 * template previews). Without Get Content it is exactly what it always was: the newest uploaded logo. After Get Content the approved logo wins, as long as its
 * file still exists. A project that never used Get Content has no row here and nothing changes for it.
 */
@Injectable()
export class ProjectBrandService {
  constructor(private prisma: PrismaService) {}

  content(projectId: string) {
    return this.prisma.projectBrandContent.findUnique({ where: { projectId } }).catch(() => null);
  }

  /** The logo asset the project uses: the approved one if there is one (and its file is still there), else the newest uploaded logo (the earlier behaviour). */
  async logoAsset(projectId: string) {
    const brand = await this.content(projectId);
    if (brand?.logoAssetId) {
      const approved = await this.prisma.projectAsset.findFirst({ where: { id: brand.logoAssetId, projectId, type: 'logo', mimeType: { startsWith: 'image/' } } });
      if (approved) return approved;
    }
    return this.prisma.projectAsset.findFirst({ where: { projectId, type: 'logo', mimeType: { startsWith: 'image/' } }, orderBy: { createdAt: 'desc' } });
  }

  /**
   * What the campaign is told about approved brand content. null = the owner never approved anything with Get Content: the run behaves exactly as before.
   * The logo is reported as approved only when it is the logo the run actually uses.
   */
  async brandContext(projectId: string, logoAssetId: string | null): Promise<BrandContext | null> {
    const brand = await this.content(projectId);
    if (!brand) return null;
    const photos = await this.prisma.projectImage
      .findMany({ where: { projectId, role: 'photo', status: 'approved', assetId: { not: null } }, select: { rightsJson: true } })
      .then((rows) => rows.filter((r) => exportEligibility(r.rightsJson as unknown as ImageRights).eligible).length)
      .catch(() => 0);
    const logoApproved = !!brand.logoAssetId && brand.logoAssetId === logoAssetId;
    return {
      logo: logoApproved ? { approved: true, assetId: brand.logoAssetId!, source: brand.logoSource ?? 'upload', fileName: brand.logoFileName ?? 'logo', width: brand.logoWidth, height: brand.logoHeight } : null,
      approvedPhotos: photos,
      approvedAt: brand.approvedAt?.toISOString() ?? null,
    };
  }

  /** Records that the owner approved brand content now (photographs, or a logo through `setLogo`). */
  async touchApproved(projectId: string, userId: string) {
    const now = new Date();
    await this.prisma.projectBrandContent.upsert({ where: { projectId }, create: { projectId, approvedAt: now, approvedById: userId }, update: { approvedAt: now, approvedById: userId } });
  }

  async setLogo(projectId: string, userId: string, o: { assetId: string; source: string; fileName: string; sha256: string | null; width: number | null; height: number | null; rights: unknown }) {
    const now = new Date();
    const data = { logoAssetId: o.assetId, logoSource: o.source, logoFileName: o.fileName.slice(0, 160), logoSha256: o.sha256, logoWidth: o.width, logoHeight: o.height, logoRightsJson: o.rights as never, approvedAt: now, approvedById: userId };
    return this.prisma.projectBrandContent.upsert({ where: { projectId }, create: { projectId, ...data }, update: data });
  }
}
