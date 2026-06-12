import { describe, expect, test } from 'vitest';
import { hashOpKey, opIndexKvKey, opStateKvKey } from '../../src/control-plane/jetstream';
import {
  buildInferProgressForPageParsed,
  buildInferProgressForPageStart,
} from '../../src/pdf-progress';
import { buildPdfOperationKey } from '../../src/api/operation-keys';
import { parsedPdfArtifactKey } from '../../src/storage/artifact-addressing';

describe('compute worker helpers', () => {
  test('hash and kv key helpers are stable and deterministic', () => {
    const hashA = hashOpKey('doc-123|layout|v1');
    const hashB = hashOpKey('doc-123|layout|v1');
    const hashC = hashOpKey('doc-123|layout|v2');

    expect(hashA).toBe(hashB);
    expect(hashA).toHaveLength(64);
    expect(hashC).not.toBe(hashA);

    expect(opIndexKvKey('doc-123|layout|v1')).toBe(`op_index.${hashA}`);
    expect(opStateKvKey('op-1')).toBe('op_state.op-1');
  });

  test('progress helpers infer page counters correctly', () => {
    expect(buildInferProgressForPageStart({ pageNumber: 1, totalPages: 12 })).toEqual({
      totalPages: 12,
      pagesParsed: 0,
      currentPage: 1,
      phase: 'infer',
    });

    expect(buildInferProgressForPageParsed({ pageNumber: 5, totalPages: 12 })).toEqual({
      totalPages: 12,
      pagesParsed: 5,
      currentPage: 5,
      phase: 'infer',
    });
  });

  test('parser-version changes rotate worker-owned operation and artifact identities', () => {
    const request = {
      documentId: 'a'.repeat(64),
      namespace: null,
      documentObjectKey: `openreader/${'a'.repeat(64)}.pdf`,
    };

    expect(buildPdfOperationKey(request, 'parser-v1'))
      .not.toBe(buildPdfOperationKey(request, 'parser-v2'));
    expect(parsedPdfArtifactKey({ ...request, prefix: 'openreader', parserVersion: 'parser-v1' }))
      .not.toBe(parsedPdfArtifactKey({ ...request, prefix: 'openreader', parserVersion: 'parser-v2' }));
  });
});
