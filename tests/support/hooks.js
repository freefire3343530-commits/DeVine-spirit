// ESM resolve hook: if the real `express`/`cors` are not installed, fall back to the shims in this folder.
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' && (specifier === 'express' || specifier === 'cors')) {
      const file = specifier === 'express' ? './miniExpress.js' : './corsShim.js';
      return { url: new URL(file, import.meta.url).href, shortCircuit: true };
    }
    throw e;
  }
}
