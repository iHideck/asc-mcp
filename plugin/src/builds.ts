import { z } from 'zod';
import { toOne } from './client.ts';

export const Build = z.object({
  type: z.literal('builds'),
  id: z.string(),
  attributes: z.object({
    version: z.string(),
    uploadedDate: z.string(),
    expired: z.boolean(),
    processingState: z.string(),
    buildAudienceType: z.string().nullable(),
    usesNonExemptEncryption: z.boolean().nullable(),
  }),
  relationships: z.object({ preReleaseVersion: toOne }),
});

export const PreReleaseVersion = z.object({
  type: z.literal('preReleaseVersions'),
  id: z.string(),
  attributes: z.object({ version: z.string() }),
});

export type BuildResource = z.infer<typeof Build>;

export function unusableReason({ attributes }: BuildResource): string | undefined {
  if (attributes.processingState !== 'VALID') {
    return `処理の状態が ${attributes.processingState} です。VALID になってから選んでください。`;
  }
  if (attributes.expired) {
    return '期限が切れています。';
  }
  if (attributes.buildAudienceType === 'INTERNAL_ONLY') {
    return 'TestFlight の内部テスト専用のビルドなので、App Store には出せません。';
  }
  return undefined;
}
