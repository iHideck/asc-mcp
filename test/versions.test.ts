import { describe, expect, it } from 'vitest';
import { notEditableError, type Version } from '../plugin/src/versions.ts';

function version(state: string): Version {
  return {
    id: 'v102',
    buildId: null,
    phasedReleaseId: null,
    status: {
      versionString: '1.0.2',
      state,
      releaseType: 'MANUAL',
      earliestReleaseDate: null,
      createdDate: null,
      build: null,
      phasedRelease: null,
    },
  };
}

describe('notEditableError', () => {
  it('まだ出していない提出に入った版には、出すか外すよう、審査中の版には、取り下げるよう返す', () => {
    expect(notEditableError(version('READY_FOR_REVIEW')).message).toMatch(
      /まだ出していない審査への提出に入っています[\s\S]*submit_for_review/,
    );
    expect(notEditableError(version('WAITING_FOR_REVIEW')).message).toContain(
      '審査から外すと変えられるようになります',
    );
  });
});
