export async function persistParsedPdfWhileSourceExists(input: {
  sourceObjectKey: string;
  sourceExists: (key: string) => Promise<boolean>;
  putParsedObject: () => Promise<string>;
  deleteParsedObject: (key: string) => Promise<void>;
}): Promise<string> {
  if (!await input.sourceExists(input.sourceObjectKey)) {
    throw new Error('PDF source object was deleted before parsed output could be persisted');
  }

  const parsedObjectKey = await input.putParsedObject();
  if (!await input.sourceExists(input.sourceObjectKey)) {
    await input.deleteParsedObject(parsedObjectKey);
    throw new Error('PDF source object was deleted while parsed output was being persisted');
  }

  return parsedObjectKey;
}
