import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import {
  extractImportMetadata,
  normalizeAuthor,
  readEpubMetadata,
  readOpfMetadata,
  readPdfMetadata,
} from '@/lib/server/documents/import-metadata';
import { detectTextLanguage } from '@/lib/server/documents/text-language';

/** Builds a minimal ZIP (one deflated entry per file) the way EPUB writers do. */
function buildZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.from(text, 'utf8');
    const data = name === 'mimetype' ? raw : deflateRawSync(raw);
    const method = name === 'mimetype' ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const PARAGRAPHS: Record<string, string> = {
  en: 'The old house stood at the end of the lane, and in the evening the light from its windows fell across the garden. It was there that she had spent most of her childhood, reading by the fire while the wind moved through the trees. When she returned many years later, the rooms were smaller than she remembered, but the smell of the books was the same.',
  es: 'La casa vieja estaba al final del camino, y por la tarde la luz de sus ventanas caía sobre el jardín. Fue allí donde ella pasó la mayor parte de su infancia, leyendo junto al fuego mientras el viento se movía entre los árboles. Cuando volvió muchos años después, las habitaciones eran más pequeñas de lo que recordaba, pero el olor de los libros era el mismo.',
  pt: 'A casa velha ficava no fim do caminho, e ao entardecer a luz das suas janelas caía sobre o jardim. Foi ali que ela passou a maior parte da sua infância, lendo junto ao fogo enquanto o vento se movia entre as árvores. Quando voltou muitos anos depois, os quartos eram menores do que ela se lembrava, mas o cheiro dos livros era o mesmo.',
  fr: 'La vieille maison se trouvait au bout du chemin, et le soir la lumière de ses fenêtres tombait sur le jardin. C’est là qu’elle avait passé la plus grande partie de son enfance, à lire près du feu pendant que le vent passait dans les arbres. Quand elle est revenue bien des années plus tard, les pièces étaient plus petites que dans son souvenir, mais l’odeur des livres était la même.',
  de: 'Das alte Haus stand am Ende des Weges, und am Abend fiel das Licht aus seinen Fenstern auf den Garten. Dort hatte sie den größten Teil ihrer Kindheit verbracht und am Feuer gelesen, während der Wind durch die Bäume ging. Als sie viele Jahre später zurückkehrte, waren die Zimmer kleiner, als sie es in Erinnerung hatte, aber der Geruch der Bücher war noch derselbe.',
  it: 'La vecchia casa si trovava alla fine del sentiero, e la sera la luce delle sue finestre cadeva sul giardino. Era lì che lei aveva passato la maggior parte della sua infanzia, a leggere vicino al fuoco mentre il vento si muoveva tra gli alberi. Quando tornò molti anni dopo, le stanze erano più piccole di come le ricordava, ma l’odore dei libri era lo stesso.',
  nl: 'Het oude huis stond aan het einde van het pad, en in de avond viel het licht van de ramen over de tuin. Daar had zij het grootste deel van haar jeugd doorgebracht, lezend bij het vuur terwijl de wind door de bomen ging. Toen zij vele jaren later terugkwam, waren de kamers kleiner dan zij zich herinnerde, maar de geur van de boeken was nog steeds dezelfde.',
  ru: 'Старый дом стоял в конце дороги, и по вечерам свет из его окон падал на сад. Именно там она провела большую часть своего детства, читая у огня, пока ветер шумел в деревьях. Когда она вернулась много лет спустя, комнаты оказались меньше, чем она помнила, но запах книг остался прежним.',
  ja: '古い家は小道の突き当たりに建っていて、夕方になると窓からの光が庭に落ちていました。彼女は子供時代のほとんどをそこで過ごし、風が木々の間を吹き抜ける間、暖炉のそばで本を読んでいました。何年も後に戻ってきたとき、部屋は記憶よりも小さかったけれど、本の匂いは同じでした。',
  zh: '那座老房子坐落在小路的尽头，傍晚时分，窗户里的灯光洒落在花园里。她在那里度过了童年的大部分时光，在炉火旁读书，而风在树林间穿行。多年以后她回到那里，房间比她记忆中的要小，但书本的气味依然如故。',
};

describe('text language detection', () => {
  test.each(Object.entries(PARAGRAPHS))('recognises %s body text', (language, paragraph) => {
    expect(detectTextLanguage(paragraph)).toBe(language);
  });

  test('votes across three spaced samples of a long text', () => {
    const preface = PARAGRAPHS.fr;
    const body = Array.from({ length: 40 }, () => PARAGRAPHS.en).join(' ');
    expect(detectTextLanguage(`${preface} ${body}`)).toBe('en');
  });

  test('prefers unknown for mixed or too-short text', () => {
    expect(detectTextLanguage(readFileSync('tests/files/multilingual-sample.txt', 'utf8'))).toBeNull();
    expect(detectTextLanguage('Chapter 1')).toBeNull();
  });
});

describe('EPUB metadata', () => {
  test('reads author and language from the bundled sample EPUB', () => {
    expect(readEpubMetadata(readFileSync('tests/files/sample.epub'))).toEqual({
      author: 'L. Frank Baum',
      language: 'en',
    });
  });

  test('follows container.xml to the package and skips non-author creators', () => {
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:creator id="c1">Jane Austen</dc:creator>
    <dc:creator id="c2">Hugh Thomson</dc:creator>
    <meta refines="#c2" property="role" scheme="marc:relators">ill</meta>
    <dc:language>en-GB</dc:language>
  </metadata>
</package>`;
    const epub = buildZip({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': opf,
    });
    expect(readEpubMetadata(epub)).toEqual({ author: 'Jane Austen', language: 'en-GB' });
  });

  test('honours EPUB 2 opf:role and joins several authors', () => {
    expect(readOpfMetadata(`
      <dc:creator opf:role="aut">Ada &amp; Co</dc:creator>
      <dc:creator opf:role="aut">Grace Hopper</dc:creator>
      <dc:creator opf:role="trl">Someone Else</dc:creator>
      <dc:language>fr</dc:language>`)).toEqual({ author: 'Ada & Co, Grace Hopper', language: 'fr' });
  });

  test('returns nulls for bytes that are not an EPUB', () => {
    expect(readEpubMetadata(Buffer.from('not a zip'))).toEqual({ author: null, language: null });
  });
});

describe('PDF metadata', () => {
  test('reads an uncompressed info dictionary and catalog language', () => {
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Catalog /Lang (de-DE) >> endobj\n'
      + '2 0 obj << /Title (A \\(nested\\) title) /Author (Ren\\351 Descartes) >> endobj\n'
      + 'trailer << /Info 2 0 R /Root 1 0 R >>\n%%EOF',
      'latin1',
    );
    expect(readPdfMetadata(pdf)).toEqual({ author: 'René Descartes', language: 'de-DE' });
  });

  test('decodes UTF-16 hex strings and falls back to XMP', () => {
    const utf16 = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Zoë', 'utf16le').swap16()]);
    const hexAuthor = Buffer.from(`<< /Author <${utf16.toString('hex')}> >>`, 'latin1');
    expect(readPdfMetadata(hexAuthor).author).toBe('Zoë');

    const xmp = Buffer.from(`<x:xmpmeta><rdf:RDF><rdf:Description>
      <dc:creator><rdf:Seq><rdf:li>Mary Shelley</rdf:li></rdf:Seq></dc:creator>
      <dc:language><rdf:Bag><rdf:li>en-US</rdf:li></rdf:Bag></dc:language>
    </rdf:Description></rdf:RDF></x:xmpmeta>`, 'utf8');
    expect(readPdfMetadata(xmp)).toEqual({ author: 'Mary Shelley', language: 'en-US' });
  });

  test('ignores placeholder authors and the bundled sample with none', () => {
    expect(readPdfMetadata(Buffer.from('<< /Author (Microsoft Office User) >>', 'latin1')).author).toBeNull();
    expect(readPdfMetadata(readFileSync('tests/files/sample.pdf'))).toEqual({ author: null, language: null });
  });
});

describe('extractImportMetadata', () => {
  test('prefers explicit hints over embedded metadata', () => {
    expect(extractImportMetadata({
      type: 'epub',
      name: 'book.epub',
      body: readFileSync('tests/files/sample.epub'),
      hints: { author: '  Catalog   Author ', language: 'en-us' },
    })).toEqual({ author: 'Catalog Author', language: 'en-US' });
  });

  test('uses the html lang attribute, then detected body text', () => {
    expect(extractImportMetadata({
      type: 'html',
      name: 'page.html',
      body: Buffer.from(`<html lang="pt-BR"><body><p>${PARAGRAPHS.es}</p></body></html>`),
    })).toEqual({ author: null, language: 'pt-BR' });
    expect(extractImportMetadata({
      type: 'html',
      name: 'notes.md',
      body: Buffer.from(`# Notes\n\n${PARAGRAPHS.de}`),
    })).toEqual({ author: null, language: 'de' });
  });

  test('keeps a hinted language and never throws on unreadable bodies', () => {
    expect(extractImportMetadata({ type: 'pdf', name: 'x.pdf', body: Buffer.alloc(0) }))
      .toEqual({ author: null, language: null });
    expect(extractImportMetadata({ type: 'pdf', name: 'x.pdf', body: null, hints: { language: 'ja' } }))
      .toEqual({ author: null, language: 'ja' });
  });

  test('normalizes and bounds author names', () => {
    expect(normalizeAuthor('a\u0000b')).toBe('a b');
    expect(normalizeAuthor('x'.repeat(400))).toHaveLength(300);
    expect(normalizeAuthor(42)).toBeNull();
  });
});
