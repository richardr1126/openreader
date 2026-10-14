import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { splitCopyright } from '../../scripts/collect-acknowledgements.mjs';
import { filterAcknowledgements, type AcknowledgementsData } from '@/lib/shared/acknowledgements';

const root = process.cwd();
const readJson = <T>(relativePath: string): T => JSON.parse(readFileSync(resolve(root, relativePath), 'utf8')) as T;

const MIT_BODY = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software.`;

describe('acknowledgements collection', () => {
  test('shares one licence text between projects and keeps each copyright line', () => {
    const a = splitCopyright(MIT_BODY.replace('MIT License\n', 'MIT License\n\nCopyright (c) 2022 OpenAI\n'));
    const b = splitCopyright(MIT_BODY.replace('MIT License\n', 'MIT License\n\nCopyright (c) Meta Platforms, Inc.\n'));
    expect(a.body).toBe(b.body);
    expect(a.copyright).toEqual(['Copyright (c) 2022 OpenAI']);
    expect(b.copyright).toEqual(['Copyright (c) Meta Platforms, Inc.']);
  });

  test('leaves licence prose and the licence\'s own notices in the text', () => {
    const gpl = splitCopyright([
      ' Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>',
      'copyright notice that is included in or attached to the work',
      '(c) You must retain, in the Source form of any Derivative Works',
      '    Copyright (C) <year>  <name of author>',
    ].join('\n'));
    expect(gpl.copyright).toEqual([]);

    const apache = splitCopyright('APPENDIX: How to apply the Apache License to your work.\n\n   Copyright 2019 Amazon.com, Inc.');
    expect(apache.copyright).toEqual(['Copyright 2019 Amazon.com, Inc.']);
    expect(apache.body).toContain('Copyright [yyyy] [name of copyright owner]');
  });
});

describe('generated acknowledgements', () => {
  const data = readJson<AcknowledgementsData>('public/acknowledgements.json');
  const manifest = readJson<{ components: { name: string; license: string }[] }>('scripts/acknowledgements/manifest.json');

  test('credits every manifest component and resolves every licence text', () => {
    for (const entry of manifest.components) {
      expect(data.components.find((component) => component.name === entry.name)?.license, entry.name).toBe(entry.license);
    }
    const referenced = new Set(data.components.flatMap((component) => component.textIds));
    expect([...referenced].filter((id) => !(id in data.texts))).toEqual([]);
    expect(Object.keys(data.texts).filter((id) => !referenced.has(id))).toEqual([]);
  });

  test('credits the Electron version the desktop app pins', () => {
    const desktop = readJson<{ devDependencies: Record<string, string> }>('desktop/package.json');
    expect(data.components.find((component) => component.name === 'Electron')?.versions).toEqual([desktop.devDependencies.electron]);
  });

  test('credits shipped dependencies, not workspace packages or test tooling', () => {
    const names = new Set(data.components.map((component) => component.name));
    expect(names.has('next')).toBe(true);
    expect(names.has('fastify')).toBe(true);
    expect(names.has('pg')).toBe(true);
    // ffmpeg ships as the pinned LGPL binary (a manifest entry), never ffmpeg-static.
    expect(names.has('ffmpeg-static')).toBe(false);
    expect(data.components.find((component) => component.name === 'FFmpeg')?.license).toBe('LGPL-3.0-or-later');
    for (const name of ['vitest', 'vite', '@playwright/test', 'typescript']) expect(names.has(name), name).toBe(false);
    expect([...names].filter((name) => name.startsWith('@openreader/'))).toEqual([]);
    // Native builds are folded so the output does not depend on the generating machine.
    expect([...names].filter((name) => /-(darwin|linux|win32)-/.test(name))).toEqual([]);
  });

  test('filters by name or licence', () => {
    expect(filterAcknowledgements(data.components, 'gpl').map((component) => component.license))
      .toEqual(expect.arrayContaining(['LGPL-3.0-or-later', 'LGPL-2.0-or-later']));
    expect(filterAcknowledgements(data.components, '  ')).toHaveLength(data.components.length);
  });
});
