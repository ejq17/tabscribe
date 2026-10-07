// Node ESM resolve hook: make '@tonejs/midi' resolve to its ESM build so src/importers/midi.ts links under tsx.
export async function resolve(specifier, context, next) {
  if (specifier === '@tonejs/midi') {
    const { pathToFileURL } = await import('node:url');
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const pkg = req.resolve('@tonejs/midi/package.json');
    return { url: pathToFileURL(pkg.replace('package.json', 'dist/Midi.js')).href, shortCircuit: true };
  }
  return next(specifier, context);
}
