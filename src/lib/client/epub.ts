export function findCommonBase(startCfi: string, endCfi: string): string {
  // Remove 'epubcfi(' prefix and ')' suffix
  const start = startCfi.replace(/^epubcfi\(|\)$/g, '');
  const end = endCfi.replace(/^epubcfi\(|\)$/g, '');

  const startParts = start.split('/');
  const endParts = end.split('/');
  
  const commonParts: string[] = [];
  
  for (let i = 0; i < startParts.length && i < endParts.length; i++) {
    if (startParts[i] === endParts[i]) {
      commonParts.push(startParts[i]);
    } else {
      break;
    }
  }

  return commonParts.join('/');
}

export function createRangeCfi(startCfi: string, endCfi: string): string {
  // Clean the CFIs
  const start = startCfi.replace(/^epubcfi\(|\)$/g, '');
  const end = endCfi.replace(/^epubcfi\(|\)$/g, '');
  
  // Find the common base path
  const base = findCommonBase(startCfi, endCfi);
  
  // Get the unique parts of start and end
  const startUnique = start.substring(base.length);
  const endUnique = end.substring(base.length);
  
  // Construct the range CFI
  return `epubcfi(${base},${startUnique},${endUnique})`;
}
