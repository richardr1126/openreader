import type { PdfLayoutProgress } from '../api/contracts';

export function buildInferProgressForPageStart(input: {
  pageNumber: number;
  totalPages: number;
}): PdfLayoutProgress {
  return {
    totalPages: input.totalPages,
    pagesParsed: Math.max(0, input.pageNumber - 1),
    currentPage: input.pageNumber,
    phase: 'infer',
  };
}

export function buildInferProgressForPageParsed(input: {
  pageNumber: number;
  totalPages: number;
}): PdfLayoutProgress {
  return {
    totalPages: input.totalPages,
    pagesParsed: input.pageNumber,
    currentPage: input.pageNumber,
    phase: 'infer',
  };
}
