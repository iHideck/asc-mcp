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
    return `The processing state is ${attributes.processingState}. Wait until processing finishes (the state becomes VALID).`;
  }
  if (attributes.expired) {
    return 'The build has expired. Upload a new build, then select it again.';
  }
  if (attributes.buildAudienceType === 'INTERNAL_ONLY') {
    return 'The build is for TestFlight internal testing only, so you cannot submit it to the App Store. Upload a build that you can submit to the App Store, then select it again.';
  }
  return undefined;
}
